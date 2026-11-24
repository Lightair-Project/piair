// One compiled binary per platform (like Pi's scripts/build-binaries.sh): dist/<target>/piair.
// bun scripts/build.ts [target…]   targets: darwin-arm64 darwin-x64 windows-x64 (default: all)
import { $ } from "bun";

const ALL: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "windows-x64": "bun-windows-x64-baseline",
};
// The page a subscription's sign-in comes back to: Lightair's (src/oauth-page.ts) instead of Pi's.
const ownSignInPage: import("bun").BunPlugin = {
  name: "lightair-sign-in-page",
  setup(build) {
    build.onLoad({ filter: /pi-ai[\\/]dist[\\/]utils[\\/]oauth-page\.js$/ }, async () => ({
      contents: await Bun.file(new URL("../src/oauth-page.ts", import.meta.url)).text(),
      loader: "ts",
    }));
  },
};

// Realtime voice's WebRTC addon (node-datachannel), embedded per target so it works on every
// platform. The host platform's package is already in node_modules; a cross-target one is fetched
// from npm into a cache. scripts/build.ts replaces src/ndc.ts with a static import of this file.
const NDC_PLATFORM: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "windows-x64": "win32-x64-msvc",
};

async function ndcAddonPath(target: string): Promise<string> {
  const { resolve } = await import("node:path");
  const platform = NDC_PLATFORM[target];
  if (!platform) throw new Error(`no node-datachannel addon for ${target}`);
  const local = `node_modules/@node-datachannel/${platform}/node_datachannel.node`;
  if (await Bun.file(local).exists()) return resolve(local);
  // cross-building for another platform: fetch that platform's addon package
  const version = JSON.parse(await Bun.file("node_modules/node-datachannel/package.json").text()).version;
  const cache = `node_modules/.cache/ndc/${platform}-${version}`;
  const dest = `${cache}/node_datachannel.node`;
  if (!(await Bun.file(dest).exists())) {
    await $`mkdir -p ${cache}`.quiet();
    await $`npm pack @node-datachannel/${platform}@${version} --pack-destination ${cache}`.quiet();
    const tgz = (await (await import("node:fs/promises")).readdir(cache)).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`couldn't fetch @node-datachannel/${platform}`);
    await $`tar -xf ${cache}/${tgz} -C ${cache} --strip-components=1 package/node_datachannel.node`.quiet();
  }
  return resolve(dest);
}

function ndcAddon(addonPath: string): import("bun").BunPlugin {
  return {
    name: "ndc-addon",
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]ndc\.ts$/ }, () => ({
        contents: `import addon from ${JSON.stringify(addonPath)};\nexport default addon;\n`,
        loader: "ts",
      }));
    },
  };
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ALL);
for (const t of targets) {
  const bunTarget = ALL[t];
  if (!bunTarget) throw new Error(`unknown target ${t}`);
  const out = `dist/${t}/piair${t.startsWith("windows") ? ".exe" : ""}`;
  const started = performance.now();
  const r = await Bun.build({
    entrypoints: ["src/main.ts"],
    compile: { target: bunTarget as any, outfile: out, autoloadBunfig: false, autoloadDotenv: false },
    minify: true,
    sourcemap: "none",
    plugins: [ownSignInPage, ndcAddon(await ndcAddonPath(t))],
  });
  if (!r.success) throw new AggregateError(r.logs, `building ${t} failed`);
  // Bun's own signature doesn't satisfy macOS on arm64 (killed at launch): sign ad hoc here;
  // Lightair's `cargo xtask dist` signs it again with the app's identity
  if (t.startsWith("darwin") && process.platform === "darwin") await $`codesign --force --sign - ${out}`.quiet();
  const size = (await Bun.file(out).size) / 1e6;
  console.log(`${out}  ${size.toFixed(1)} MB  ${Math.round(performance.now() - started)} ms`);
}
