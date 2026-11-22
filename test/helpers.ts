// Test helpers: what PiAir writes to Lightair (its stdout lines), caught instead of printed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Line = { t: string; [k: string]: any };

/** Catches PiAir's protocol lines (stdout) while a test runs; `lines()` reads them. */
export function catchLines() {
  const caught: Line[] = [];
  const real = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    let all = true;
    for (const l of text.split("\n").filter(Boolean)) {
      try {
        caught.push(JSON.parse(l));
      } catch {
        all = false;
      }
    }
    return all ? true : real(chunk, ...rest);
  };
  return {
    lines: () => caught,
    of: (t: string) => caught.filter((l) => l.t === t),
    clear: () => caught.splice(0),
    restore: () => ((process.stdout as any).write = real),
  };
}

export function tempDir(prefix = "piair-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}
