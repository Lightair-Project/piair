export {};
export {};
// Does the co-host call computer_task when the streamer asks? Runs PiAir under a fake Lightair.
const model = process.argv[2] ?? "gemini-flash-lite-latest";
const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
const dir = mkdtempSync("/tmp/piair-tc-");
mkdirSync(`${dir}/PiAir`, { recursive: true });
writeFileSync(`${dir}/PiAir/settings.json`, JSON.stringify({ model, voice: { vendor: "none" } }));
const child = Bun.spawn(["bun", "src/main.ts"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const send = (m: object) => { child.stdin.write(JSON.stringify(m) + "\n"); child.stdin.flush(); };
let called = "", said = "";
const done = (async () => {
  const dec = new TextDecoder(); let buf = "";
  for await (const c of child.stdout) {
    buf += dec.decode(c, { stream: true }); let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1);
      if (m.t === "call") send({ t: "reply", id: m.id, ...(m.method === "secret.get" ? { result: { value: null } } : { error: { code: "test", message: "test harness" } }) });
      if (m.t === "ready") send({ t: "prompt", text: "Use the computer: click into the empty TextEdit document and type: Hello from PiAir." });
      if (m.t === "transcript" && m.role === "tool") called ||= m.text;
      if (m.t === "transcript" && m.role === "piair") { said = m.text; return; }
      if (m.t === "status" && m.state === "error") { said = "ERROR " + m.detail; return; }
    }
  }
})();
send({ t: "hello", data_dir: dir });
await Promise.race([done, Bun.sleep(40000)]);
console.log(JSON.stringify({ model, called, said: said.slice(0, 100) }));
child.kill();
