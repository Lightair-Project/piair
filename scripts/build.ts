// One compiled binary per platform (like Pi's scripts/build-binaries.sh): dist/<target>/piair.
// bun scripts/build.ts [target…]   targets: darwin-arm64 darwin-x64 windows-x64 (default: all)
import { $ } from "bun";

const ALL: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "windows-x64": "bun-windows-x64-baseline",
};
const targets = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ALL);
for (const t of targets) {
  const bunTarget = ALL[t];
  if (!bunTarget) throw new Error(`unknown target ${t}`);
  const out = `dist/${t}/piair${t.startsWith("windows") ? ".exe" : ""}`;
  const started = performance.now();
  await $`bun build --compile --minify --sourcemap=none --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target=${bunTarget} src/main.ts --outfile ${out}`.quiet();
  // Bun's own signature doesn't satisfy macOS on arm64 (killed at launch): sign ad hoc here;
  // Lightair's `cargo xtask dist` signs it again with the app's identity
  if (t.startsWith("darwin") && process.platform === "darwin") await $`codesign --force --sign - ${out}`.quiet();
  const size = (await Bun.file(out).size) / 1e6;
  console.log(`${out}  ${size.toFixed(1)} MB  ${Math.round(performance.now() - started)} ms`);
}
