// Drives PiAir like Lightair would, over its pipes: hello, a prompt from the streamer, a chat
// message. Answers calls with canned results, saves the voice to a WAV, prints timings.
// Run: bun proto/fake-lightair.ts [out.wav]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "piair-"));
const child = Bun.spawn(process.env.PIAIR_BIN ? [process.env.PIAIR_BIN] : ["bun", new URL("../src/main.ts", import.meta.url).pathname], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const sendLine = (m: object) => {
  child.stdin.write(JSON.stringify(m) + "\n");
  child.stdin.flush();
};
const pcm: Uint8Array[] = [];
let t0 = 0;
let firstVoice = 0;
let lastUtterance = "";
const events: string[] = [];
let ready!: () => void;
const isReady = new Promise<void>((r) => (ready = r));
let spoke!: () => void;
let spokeP = new Promise<void>((r) => (spoke = r));

(async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of child.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, k));
      buf = buf.slice(k + 1);
      if (m.t === "ready") {
        console.log(`ready: ${m.settings.provider}/${m.settings.model}, ${m.providers.length} providers`);
        ready();
      } else if (m.t === "call") {
        let result: any = {};
        if (m.method === "secret.get") result = { value: null };
        else if (m.method === "state.get") result = { scenes: [{ name: "Just Chatting", program: true }] };
        sendLine({ t: "reply", id: m.id, result });
        events.push(`call ${m.method}`);
      } else if (m.t === "voice") {
        if (!firstVoice && m.utterance !== lastUtterance) {
          lastUtterance = m.utterance;
          firstVoice = performance.now() - t0;
          sendLine({ t: "voice_state", utterance: m.utterance, state: "playing" });
        }
        pcm.push(Buffer.from(m.pcm, "base64"));
      } else if (m.t === "voice_end") {
        sendLine({ t: "voice_state", utterance: m.utterance, state: "done" });
        spoke();
      } else if (m.t === "transcript") {
        console.log(`  ${m.role}: ${m.text}`);
        if (m.role === "piair") setTimeout(() => !firstVoice && spoke(), 15_000); // no voice
      } else if (m.t === "status" && m.state === "error") console.log(`  status error: ${m.detail}`);
    }
  }
})();

sendLine({ t: "hello", version: 1, platform: process.platform, data_dir: dataDir, lightair: { version: "dev" } });
await isReady;

t0 = performance.now();
firstVoice = 0;
sendLine({ t: "prompt", text: "Say hi to everyone and tell them what we're doing today: building a cozy farm." });
await Promise.race([spokeP, Bun.sleep(30_000)]);
console.log(`prompt → first voice: ${Math.round(firstVoice)} ms`);

spokeP = new Promise<void>((r) => (spoke = r));
await Bun.sleep(500);
t0 = performance.now();
firstVoice = 0;
sendLine({ t: "chat", event: { kind: "message", platform: "twitch", user: { id: "42", display_name: "kiwi_bird" }, text: "Pi what crop should we plant first?" } });
await Promise.race([spokeP, Bun.sleep(30_000)]);
console.log(`chat → first voice: ${Math.round(firstVoice)} ms`);

const out = process.argv[2];
if (out && pcm.length) {
  const data = Buffer.concat(pcm);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  await Bun.write(out, Buffer.concat([h, data]));
  console.log(`voice: ${(data.length / 48000).toFixed(1)} s → ${out}`);
}
child.stdin.end();
await child.exited;
