// AI streamer mode (PiAir 0.3.0): its tools carry chat's allowed requests to Lightair, every call
// says what caused it so Lightair can apply chat's stricter rules, and Lightair's refusals reach the
// model so it can say no instead of pretending. PiAir runs as a program on its channel (with Pi's
// faux model); the test plays Lightair, answering its calls.
import { expect, test } from "bun:test";
import type { Line } from "./helpers.ts";

const POLICY = { scenes: ["Gameplay"], sites: ["youtube.com"], games: ["com.example.racer"], chat_browse: true, chat_plays: ["com.example.racer"] };

function piair() {
  const child = Bun.spawn(["bun", new URL("./fixtures/streamer.ts", import.meta.url).pathname], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const lines: Line[] = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const c of child.stdout) {
      buf += dec.decode(c, { stream: true });
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, k)));
        buf = buf.slice(k + 1);
      }
    }
  })();
  const write = (m: object) => {
    child.stdin.write(JSON.stringify(m) + "\n");
    child.stdin.flush();
  };
  /** Waits for a line (the program answers fast; the bound only catches a broken channel). */
  const next = async (ok: (l: Line) => boolean) => {
    for (let i = 0; i < 3000; i++) {
      const l = lines.find(ok);
      if (l) return l;
      await Bun.sleep(1);
    }
    throw new Error(`no such line in ${JSON.stringify(lines)}`);
  };
  /** The calls PiAir made to Lightair's methods (not its secret store). */
  const calls = () => lines.filter((l) => l.t === "call" && !String(l.method).startsWith("secret."));
  /** Switches the mode on as Lightair does, giving it everything it asks for. */
  const modeOn = async () => {
    write({ t: "mode", mode: "producer", policy: POLICY });
    const asked = await next((l) => l.t === "call" && l.method === "permissions.request");
    write({ t: "reply", id: asked.id, result: { granted: asked.params.permissions } });
    await next((l) => l.t === "mode_set");
  };
  /** Starts a turn caused by `source` in which the model asks for `tool`. */
  const turn = (source: string, tool: string, args: object) => write({ t: "turn", source, tool, args });
  return { child, write, next, calls, modeOn, turn, lines };
}

test("a chat request carried out in the mode goes to Lightair as chat's, through the policy's method", async () => {
  const p = piair();
  await p.modeOn();
  p.turn("chat", "pick_scene", { name: "Gameplay" });
  const call = await p.next((l) => l.t === "call" && l.method.startsWith("streamer."));
  expect(call.method).toBe("streamer.scene");
  expect(call.params).toEqual({ name: "Gameplay", cause: "chat" });
  p.child.kill();
});

test("a raid or paid message's request is sent as chat's too", async () => {
  const p = piair();
  await p.modeOn();
  p.turn("event", "open_site", { url: "https://www.youtube.com/watch?v=1" });
  const call = await p.next((l) => l.t === "call" && l.method === "computer.open_url");
  expect(call.params.cause).toBe("chat");
  p.child.kill();
});

test("the streamer's own request is sent as the streamer's", async () => {
  const p = piair();
  await p.modeOn();
  p.turn("streamer", "switch_app", { app: "com.example.racer" });
  const call = await p.next((l) => l.t === "call" && l.method === "streamer.app");
  expect(call.params.cause).toBe("streamer");
  p.child.kill();
});

test("what PiAir does on its own in the mode is sent as its own", async () => {
  const p = piair();
  await p.modeOn();
  p.turn("self", "chat_play", { keys: "w" });
  const call = await p.next((l) => l.t === "call" && l.method === "computer.key");
  expect(call.params.cause).toBe("self");
  p.child.kill();
});

test("when Lightair refuses, the model is told why", async () => {
  const p = piair();
  await p.modeOn();
  p.turn("chat", "open_site", { url: "https://bank.example/login" });
  const call = await p.next((l) => l.t === "call" && l.method === "computer.open_url");
  p.write({ t: "reply", id: call.id, error: { code: "site_not_allowed", message: "bank.example isn't on the stream's allowed sites" } });
  const told = await p.next((l) => l.t === "told");
  expect(told.isError).toBe(true);
  expect(told.text).toContain("bank.example isn't on the stream's allowed sites");
  p.child.kill();
});

test("with the mode off, its tools ask Lightair for nothing", async () => {
  const p = piair();
  p.turn("streamer", "chat_play", { keys: "w" });
  const told = await p.next((l) => l.t === "told");
  expect(told.text).toBe("AI streamer mode is off.");
  expect(p.calls()).toEqual([]);
  p.child.kill();
});

test("switching the mode off gives its permissions back", async () => {
  const p = piair();
  await p.modeOn();
  p.write({ t: "mode", mode: "off" });
  const given = await p.next((l) => l.t === "call" && l.method === "permissions.release");
  const asked = p.lines.find((l) => l.t === "call" && l.method === "permissions.request")!;
  expect([...given.params.permissions].sort()).toEqual([...asked.params.permissions].sort());
  p.child.kill();
});
