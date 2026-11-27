// The streamer's AI apps (design §2.3a): installed as a package, PiAir can't start programs, so
// it asks Lightair to (`cli.spawn`) and gets their output back as messages; started any other way
// it runs them itself.
import { describe, expect, test } from "bun:test";
import type { Line } from "./helpers.ts";

function program(env: Record<string, string>) {
  const child = Bun.spawn(["bun", new URL("./fixtures/apps.ts", import.meta.url).pathname], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, ...env },
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
  const next = async (ok: (l: Line) => boolean) => {
    for (let i = 0; i < 5000; i++) {
      const l = lines.find(ok);
      if (l) return l;
      await Bun.sleep(1);
    }
    throw new Error(`no such line in ${JSON.stringify(lines)}`);
  };
  return { child, write, next, lines };
}

describe("in Lightair's sandbox", () => {
  test("starting an app asks Lightair, by the app's name only", async () => {
    const p = program({ LIGHTAIR_PACKAGE: "app.lightair.piair" });
    p.write({ t: "start", bin: "/Users/me/.local/bin/claude", args: ["-p", "hi"] });
    const asked = await p.next((l) => l.t === "call" && l.method === "cli.spawn");
    expect(asked.params.name).toBe("claude");
    expect(asked.params.args).toEqual(["-p", "hi"]);
    p.child.kill();
  });

  test("the app's output and exit come back as if it ran here", async () => {
    const p = program({ LIGHTAIR_PACKAGE: "app.lightair.piair" });
    p.write({ t: "start", bin: "codex", args: [] });
    const asked = await p.next((l) => l.t === "call" && l.method === "cli.spawn");
    p.write({ t: "reply", id: asked.id, result: { id: 7 } });
    p.write({ t: "cli_out", id: 7, stream: "stdout", data: "an answer\n" });
    p.write({ t: "cli_exit", id: 7, code: 0 });
    expect((await p.next((l) => l.t === "out")).data).toBe("an answer\n");
    expect((await p.next((l) => l.t === "exit")).code).toBe(0);
    p.child.kill();
  });

  test("an app Lightair refuses to start ends with an error, not silence", async () => {
    const p = program({ LIGHTAIR_PACKAGE: "app.lightair.piair" });
    p.write({ t: "start", bin: "grok", args: [] });
    const asked = await p.next((l) => l.t === "call" && l.method === "cli.spawn");
    p.write({ t: "reply", id: asked.id, error: { code: "not_found", message: "grok isn't installed on this computer" } });
    await p.next((l) => l.t === "error");
    expect((await p.next((l) => l.t === "exit")).code).not.toBe(0);
    p.child.kill();
  });
});

test("outside the sandbox the app runs directly, without asking Lightair", async () => {
  const env: Record<string, string> = { LIGHTAIR_PACKAGE: "" };
  const p = program(env);
  p.write({ t: "start", bin: "/bin/echo", args: ["direct"] });
  expect((await p.next((l) => l.t === "out")).data).toBe("direct\n");
  expect(p.lines.some((l) => l.t === "call")).toBe(false);
  p.child.kill();
});
