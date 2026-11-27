// A program on PiAir's channel for the apps tests: `start` starts an app through src/apps.ts and
// reports what came back from it (`out`, `exit`).
import { spawnApp } from "../../src/apps.ts";
import { on, run, send } from "../../src/protocol.ts";

on("start", (m) => {
  const child = spawnApp(m.bin, m.args ?? [], { configEnv: [], scratch: true });
  child.stdout.on("data", (d: Buffer) => send({ t: "out", data: d.toString("utf8") }));
  child.on("exit", (code: number | null) => send({ t: "exit", code }));
  child.on("error", (e: Error) => send({ t: "error", message: String(e.message ?? e) }));
});
await run(() => setImmediate(() => process.exit(0)));
