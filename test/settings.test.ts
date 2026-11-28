// Settings saved by an older PiAir still load.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as settings from "../src/settings.ts";
import { tempDir } from "./helpers.ts";

test("a saved ChatGPT realtime voice (dropped in 0.2.2) becomes the computer's own voice", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "PiAir"), { recursive: true });
  writeFileSync(join(dir, "PiAir", "settings.json"), JSON.stringify({ voice: { vendor: "codex", voice: "cove" } }));
  settings.load(dir);
  expect(settings.get().voice.vendor).toBe("system");
  expect(settings.get().voice.voice).toBe("");
});
