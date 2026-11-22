export {};
// Memory across runs: a viewer introduces themself in one PiAir process; a new process, on the
// same data folder, is asked about it. Prints what PiAir said and the notes it kept.
const { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } = await import("node:fs");
const model = process.argv[2] ?? "gemini-flash-lite-latest";
const dir = mkdtempSync("/tmp/piair-mem-");
mkdirSync(`${dir}/PiAir`, { recursive: true });
writeFileSync(`${dir}/PiAir/settings.json`, JSON.stringify({ model, voice: { vendor: "none" }, behaviour: { chattiness: 2 } }));

async function run(chat: { who: string; id: string; text: string }) {
  const child = Bun.spawn(["bun", "src/main.ts"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const send = (m: object) => { child.stdin.write(JSON.stringify(m) + "\n"); child.stdin.flush(); };
  const lines: string[] = [];
  const done = (async () => {
    const dec = new TextDecoder(); let buf = "";
    for await (const c of child.stdout) {
      buf += dec.decode(c, { stream: true }); let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1);
        if (m.t === "call") send({ t: "reply", id: m.id, result: m.method === "secret.get" ? { value: null } : {} });
        if (m.t === "ready") send({ t: "chat", event: { kind: { type: "message" }, platform: "twitch", user: { id: chat.id, display_name: chat.who }, text: chat.text } });
        if (m.t === "transcript") lines.push(`${m.role}${m.who ? " " + m.who : ""}: ${m.text}`);
        if (m.t === "transcript" && m.role === "piair") { await Bun.sleep(3000); return; }
      }
    }
  })();
  send({ t: "hello", data_dir: dir });
  await Promise.race([done, Bun.sleep(45000)]);
  child.kill();
  return lines;
}

console.log((await run({ who: "kiwi_bird", id: "42", text: "hi Pi! I'm Maya, first time here. My favourite game is Stardew Valley and I have a cat called Biscuit" })).join("\n"));
const notes = (() => { try { return readdirSync(`${dir}/PiAir/memory/viewers/twitch`).map((f) => readFileSync(`${dir}/PiAir/memory/viewers/twitch/${f}`, "utf8")); } catch { return []; } })();
console.log("NOTES:", JSON.stringify(notes));
console.log("--- new process ---");
console.log((await run({ who: "kiwi_bird", id: "42", text: "Pi, I'm back! do you remember my cat's name and what game I love?" })).join("\n"));
