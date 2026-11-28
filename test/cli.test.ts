// The streamer's AI apps as the co-host's brain (src/cli.ts): what an app writes is what the
// co-host says, except the app's own errors. Claude Code sends an expired sign-in or a reached
// limit as a made-up assistant message; that must fail the turn, never be spoken on stream.
// A stand-in `claude` on PATH writes the lines a real one does.
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { generate } from "../src/cli.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Puts a `claude` that prints `lines` (then exits with `code`) first on PATH. */
async function fakeClaude(lines: object[], code = 0) {
  const dir = await mkdtemp(join(tmpdir(), "piair-fake-claude-"));
  dirs.push(dir);
  const body = lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join("\n");
  const file = join(dir, "claude");
  await writeFile(file, `#!${process.execPath}\nawait Bun.stdin.text();\n${body}\nprocess.exit(${code});\n`);
  await chmod(file, 0o755);
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
}

async function turn(): Promise<{ said: string[]; error?: string }> {
  const said: string[] = [];
  try {
    for await (const piece of generate("claude", "default", "You are a co-host.", "say hi", new AbortController().signal)) said.push(piece);
    return { said };
  } catch (e) {
    return { said, error: e instanceof Error ? e.message : String(e) };
  }
}

describe("Claude Code as the brain", () => {
  test("an expired sign-in fails the turn and nothing is said", async () => {
    await fakeClaude(
      [
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          error: "authentication_failed",
          message: { model: "<synthetic>", content: [{ type: "text", text: "Failed to authenticate. Please run /login" }] },
        },
        { type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. Please run /login" },
      ],
      1,
    );
    const r = await turn();
    expect(r.said).toEqual([]);
    expect(r.error).toContain("Failed to authenticate");
  });

  test("a real answer is what the co-host says", async () => {
    await fakeClaude([
      { type: "assistant", message: { model: "claude-sonnet", content: [{ type: "text", text: "Hey chat!" }] } },
      { type: "result", subtype: "success", result: "Hey chat!" },
    ]);
    const r = await turn();
    expect(r.error).toBeUndefined();
    expect(r.said).toEqual(["Hey chat!"]);
  });
});
