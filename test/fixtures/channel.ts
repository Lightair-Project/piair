// A program on PiAir's channel (src/protocol.ts) for the framing tests: answers `ping` with
// `pong`, makes the calls `ask` asks for and says how they ended, logs to stderr.
import { call, CallError, log, on, run, send } from "../../src/protocol.ts";

on("ping", (m) => {
  log("info", "a ping"); // the log never reaches the protocol stream
  send({ t: "pong", n: m.n });
});
on("ask", async (m) => {
  try {
    const result = await call(m.method, m.params ?? {}, m.timeout ?? 20_000);
    send({ t: "answer", n: m.n, result });
  } catch (e) {
    const code = e instanceof CallError ? e.code : "?";
    send({ t: "answer", n: m.n, error: code });
    process.stderr.write(`call ${m.n} ended: ${code}\n`);
  }
});
await run(() => {
  // a tick later, so the calls the close failed have said so
  setImmediate(() => {
    process.stderr.write("channel closed\n");
    process.exit(0);
  });
});
