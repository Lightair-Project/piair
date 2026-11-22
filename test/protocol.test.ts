// The channel to Lightair (design §2): newline-delimited JSON both ways over pipes, calls matched
// to replies by id, a call with no answer times out, and closing stdin ends everything.
import { describe, expect, test } from "bun:test";
import type { Line } from "./helpers.ts";

/** The fixture program on the channel, and its output as lines. */
function channel() {
  const child = Bun.spawn(["bun", new URL("./fixtures/channel.ts", import.meta.url).pathname], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: Line[] = [];
  const raw: string[] = [];
  let err = "";
  const reading = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const c of child.stdout) {
      buf += dec.decode(c, { stream: true });
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        raw.push(buf.slice(0, k));
        lines.push(JSON.parse(buf.slice(0, k)));
        buf = buf.slice(k + 1);
      }
    }
  })();
  const errReading = (async () => {
    for await (const c of child.stderr) err += new TextDecoder().decode(c);
  })();
  const write = (text: string) => {
    child.stdin.write(text);
    child.stdin.flush();
  };
  /** Waits for a line (the program answers fast; the bound only catches a broken channel). */
  const next = async (ok: (l: Line) => boolean) => {
    for (let i = 0; i < 5000; i++) {
      const l = lines.find(ok);
      if (l) return l;
      await Bun.sleep(1);
    }
    throw new Error(`no such line; got ${JSON.stringify(lines)}`);
  };
  return { child, lines, raw, write, next, stderr: () => err, done: Promise.all([reading, errReading, child.exited]) };
}

describe("framing", () => {
  test("a message split across writes, and several in one write, each arrive once and in order", async () => {
    const c = channel();
    c.write('{"t":"ping","n":1}\n{"t":"pi');
    c.write('ng","n":2}\n\n{"t":"ping",');
    c.write('"n":3}\n');
    await c.next((l) => l.n === 3);
    expect(c.lines.map((l) => l.n)).toEqual([1, 2, 3]);
    c.child.stdin.end();
    await c.done;
  });

  test("a line that isn't JSON is skipped and the channel goes on", async () => {
    const c = channel();
    c.write("not json\n{oops\n");
    c.write('{"t":"ping","n":4}\n');
    expect((await c.next((l) => l.t === "pong")).n).toBe(4);
    c.child.stdin.end();
    await c.done;
  });

  test("only protocol lines go to Lightair: the log goes to stderr", async () => {
    const c = channel();
    c.write('{"t":"ping","n":5}\n');
    await c.next((l) => l.t === "pong");
    c.child.stdin.end();
    await c.done;
    expect(c.raw).toEqual(['{"t":"pong","n":5}']);
    expect(c.stderr()).toContain("a ping");
  });
});

describe("calls", () => {
  test("replies are matched to calls by id, in whatever order they come", async () => {
    const c = channel();
    c.write('{"t":"ask","n":1,"method":"scene.list"}\n{"t":"ask","n":2,"method":"state.get"}\n');
    await c.next((l) => l.t === "call" && l.method === "state.get");
    const [a, b] = c.lines.filter((l) => l.t === "call");
    expect(a!.id).not.toBe(b!.id);
    c.write(JSON.stringify({ t: "reply", id: b!.id, result: { second: true } }) + "\n");
    c.write(JSON.stringify({ t: "reply", id: a!.id, result: { first: true } }) + "\n");
    expect((await c.next((l) => l.t === "answer" && l.n === 1)).result).toEqual({ first: true });
    expect((await c.next((l) => l.t === "answer" && l.n === 2)).result).toEqual({ second: true });
    c.child.stdin.end();
    await c.done;
  });

  test("an error reply comes back with its code", async () => {
    const c = channel();
    c.write('{"t":"ask","n":1,"method":"computer.click"}\n');
    const call = await c.next((l) => l.t === "call");
    c.write(JSON.stringify({ t: "reply", id: call.id, error: { code: "paused", message: "The human has the mouse" } }) + "\n");
    expect((await c.next((l) => l.t === "answer")).error).toBe("paused");
    c.child.stdin.end();
    await c.done;
  });

  test("a call Lightair never answers fails with a timeout", async () => {
    const c = channel();
    c.write('{"t":"ask","n":1,"method":"state.get","timeout":30}\n');
    expect((await c.next((l) => l.t === "answer")).error).toBe("timeout");
    c.child.stdin.end();
    await c.done;
  });

  test("when Lightair closes the channel, waiting calls fail and the program ends", async () => {
    const c = channel();
    c.write('{"t":"ask","n":1,"method":"state.get"}\n');
    await c.next((l) => l.t === "call");
    c.child.stdin.end();
    await c.done;
    expect(c.stderr()).toContain("call 1 ended: closed");
    expect(c.stderr()).toContain("channel closed");
    expect(c.child.exitCode).toBe(0);
  });
});
