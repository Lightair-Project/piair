export {};
// Content heard (a video playing) at Chatty: PiAir reacts now and then, never takes it as someone
// talking to it; a question said in the conversation is answered with the content as context.
// Faux model (no network).
const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
const dir = mkdtempSync("/tmp/piair-content-");
mkdirSync(`${dir}/PiAir`, { recursive: true });
writeFileSync(`${dir}/PiAir/settings.json`, JSON.stringify({ voice: { vendor: "none" }, behaviour: { chattiness: 3 } }));
const child = Bun.spawn(["bun", "src/main.ts"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, PIAIR_FAUX: "1" } });
const send = (m: object) => { child.stdin.write(JSON.stringify(m) + "\n"); child.stdin.flush(); };
const turns: string[] = [];
let t0 = 0;
let ready!: () => void;
const isReady = new Promise<void>((r) => (ready = r));
(async () => {
  const dec = new TextDecoder(); let buf = "";
  for await (const c of child.stdout) {
    buf += dec.decode(c, { stream: true }); let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1);
      if (m.t === "call") send({ t: "reply", id: m.id, result: m.method === "secret.get" ? { value: null } : {} });
      if (m.t === "ready") ready();
      if (m.t === "transcript" && m.role === "piair") turns.push(`${((performance.now() - t0) / 1000).toFixed(1)}s`);
    }
  }
})();
send({ t: "hello", data_dir: dir });
await isReady;
t0 = performance.now();
const lines = ["welcome back to the channel today we are building a tiny house", "first we lay the foundation with these concrete blocks", "the walls go up surprisingly fast with this frame", "now the roof, which is the tricky part honestly", "and that is the finished tiny house, only nine square meters", "thanks for watching and do not forget to subscribe"];
for (let i = 0; i < 9; i++) { send({ t: "content", text: lines[i % lines.length], source: "Browser" }); await Bun.sleep(2000); }
send({ t: "heard", text: "Pi what do you think of this house", final: true, who: "Mic" });
await Bun.sleep(3000);
console.log(`PiAir spoke at ${turns.join(", ")} (content every 2 s from 0 to 16 s; a question by name at 18 s)`);
child.kill();
