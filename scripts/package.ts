// PiAir as a Lightair package (app.lightair.piair): one .airpkg per platform in dist/airpkg/.
//
//   bun run package [--sign "Developer ID Application: …"] [--targets darwin-arm64,…] [--no-build]
//
// Builds the binaries (scripts/build.ts) unless --no-build; signs the macOS ones with the
// hardened runtime and Bun's JIT entitlements when --sign names an identity (ad hoc otherwise),
// and notarizes them when LIGHTAIR_NOTARY_PROFILE names a notarytool keychain profile; writes the
// package folder (dist/package/) and packs it with lightair-pack (on PATH, $LIGHTAIR_PACK, or
// the lightair-core checkout beside this one). Signing stays on the owner's Mac.
import { $ } from "bun";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// read, not imported: importing PiAir's modules starts it
const VERSION = /export const VERSION = "([^"]+)"/.exec(await Bun.file(new URL("../src/cohost.ts", import.meta.url)).text())?.[1];
if (!VERSION) throw new Error("no VERSION in src/cohost.ts");

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const identity = opt("--sign");
const targets = (opt("--targets") ?? "darwin-arm64,darwin-x64,windows-x64").split(",").filter(Boolean);

// package target name → Lightair's target name and the program inside
const TARGETS: Record<string, { lightair: string; exe: string }> = {
  "darwin-arm64": { lightair: "macos-arm64", exe: "piair" },
  "darwin-x64": { lightair: "macos-x64", exe: "piair" },
  "windows-x64": { lightair: "windows-x64", exe: "piair.exe" },
};

if (!args.includes("--no-build")) await $`bun scripts/build.ts ${targets}`;

const pkg = "dist/package";
await rm(pkg, { recursive: true, force: true });
const entry: Record<string, string> = {};
for (const t of targets) {
  const info = TARGETS[t];
  if (!info) throw new Error(`unknown target ${t}`);
  const built = join("dist", t, info.exe);
  if (!existsSync(built)) {
    console.warn(`left out ${t}: no ${built}`);
    continue;
  }
  const dest = join(pkg, "bin", t, info.exe);
  await mkdir(join(pkg, "bin", t), { recursive: true });
  await cp(built, dest);
  if (t.startsWith("darwin") && process.platform === "darwin") {
    // a real identity gets Apple's secure timestamp (notarization wants it); ad hoc can't
    const stamp = identity ? "--timestamp" : "--timestamp=none";
    await $`codesign --force --options runtime ${stamp} --entitlements scripts/entitlements.plist --sign ${identity ?? "-"} ${dest}`.quiet();
    if (identity && process.env.LIGHTAIR_NOTARY_PROFILE) {
      const zip = `${dest}.zip`;
      await $`ditto -c -k --keepParent ${dest} ${zip}`;
      await $`xcrun notarytool submit ${zip} --keychain-profile ${process.env.LIGHTAIR_NOTARY_PROFILE} --wait`;
      await rm(zip);
    }
  }
  entry[info.lightair] = `bin/${t}/${info.exe}`;
}
if (!Object.keys(entry).length) throw new Error("no binaries to package");

const manifest = {
  id: "app.lightair.piair",
  name: "PiAir",
  version: VERSION,
  lightair: ">=1.0 <2",
  author: "MoonGoblin",
  licence: "MIT",
  description: "Lightair's AI co-host: reads chat, talks through your avatar with Lightair's voices, remembers your viewers, and can use the computer while you watch.",
  platforms: [...new Set(Object.keys(entry).map((t) => t.split("-")[0]))],
  contents: [{ kind: "helper", path: "bin", entry, modes: ["piair"] }],
  permissions: [
    // its brain: any model provider, or an OpenAI-compatible address the streamer sets
    "network:*",
    // Sign in with ChatGPT comes back to this port
    "network.listen:1455",
    // its keys and sign-ins, in Lightair's Keychain
    "secrets",
    // the stream's chat, to answer it
    "chat.read",
    // Lightair's own methods (scenes, sources), as MCP clients have
    "api.call",
    // what's on screen while AI drives is on, masked to the allowed apps
    "screen.capture",
  ],
};
await writeFile(join(pkg, "lightair-package.json"), JSON.stringify(manifest, null, 2) + "\n");
await cp("LICENSE", join(pkg, "LICENSE"));
await cp("README.md", join(pkg, "README.md"));

const core = join(import.meta.dir, "../../lightair-core/target");
const pack =
  process.env.LIGHTAIR_PACK ??
  (Bun.which("lightair-pack") || [join(core, "release/lightair-pack"), join(core, "debug/lightair-pack")].find((p) => existsSync(p)));
if (!pack) throw new Error("lightair-pack not found: put it on PATH, set LIGHTAIR_PACK, or build lightair-core's");
await rm("dist/airpkg", { recursive: true, force: true });
await $`${pack} build ${pkg} --out dist/airpkg`;
console.log(`PiAir ${VERSION}: dist/airpkg/`);
