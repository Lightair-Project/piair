// The node-datachannel native addon for this build's platform. scripts/build.ts replaces this file
// at compile time with a static import of the matching @node-datachannel/<platform> addon, so Bun
// embeds the right one per target (macOS arm64/x64, Windows x64). Under `bun run` and tests it stays
// null — realtime voice (src/realtime.ts) only runs from the compiled binary.
// deno-lint-ignore no-explicit-any
export default null as any;
