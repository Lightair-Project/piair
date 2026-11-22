export {};
// A computer task under a fake Lightair whose screenshot is the real screen (nothing is clicked:
// actions are answered "ok" without doing anything). Shows the task's log.
const model = process.argv[2] ?? "gemini-flash-lite-latest";
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
const dir = mkdtempSync("/tmp/piair-task-");
mkdirSync(`${dir}/PiAir`, { recursive: true });
writeFileSync(`${dir}/PiAir/settings.json`, JSON.stringify({ model, voice: { vendor: "none" } }));
const child = Bun.spawn(["bun", "src/main.ts"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const send = (m: object) => { child.stdin.write(JSON.stringify(m) + "\n"); child.stdin.flush(); };
let steps = 0;
const done = (async () => {
  const dec = new TextDecoder(); let buf = "";
  for await (const c of child.stdout) {
    buf += dec.decode(c, { stream: true }); let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1);
      if (m.t === "call") {
        if (m.method === "secret.get") send({ t: "reply", id: m.id, result: { value: null } });
        else if (m.method === "computer.screenshot") {
          Bun.spawnSync(["screencapture", "-x", "-t", "jpg", `${dir}/s.jpg`]);
          Bun.spawnSync(["sips", "-Z", "1280", `${dir}/s.jpg`]);
          send({ t: "reply", id: m.id, result: { image: readFileSync(`${dir}/s.jpg`).toString("base64"), width: 1280, height: 831, cursor: { x: 10, y: 10 } } });
        } else { steps++; console.log("ACTION", m.method, JSON.stringify(m.params)); send({ t: "reply", id: m.id, result: {} }); }
      }
      if (m.t === "ready") send({ t: "prompt", text: "Use the computer: click into the empty TextEdit document and type: Hello from PiAir." });
      if (m.t === "transcript" && m.role === "piair") { console.log("SAID", m.text); return; }
    }
  }
})();
send({ t: "hello", data_dir: dir });
await Promise.race([done, Bun.sleep(90000)]);
child.kill();
