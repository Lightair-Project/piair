# PiAir

Lightair's AI co-host: an agent built on Pi's libraries (unified LLM API and agent loop) and
made for Lightair. It reads the stream's chat, talks with a cloud voice through the streamer's
avatar, and can use the computer (pointer, keys, Lightair's zoom) while Lightair shows every move.

Ships as one Bun-compiled binary inside Lightair.app. Design: [docs/design.md](docs/design.md);
plan and milestones: [docs/plan.md](docs/plan.md); dependency licences: [docs/licences.md](docs/licences.md).

## Where it stands

Working on macOS in Lightair's Release build: chat answered aloud through the co-host avatar with
lip sync, Lightair actions, computer use with Lightair's zoom (AI drives, the human always wins,
allowed apps, no password fields, confirmations, screenshots of allowed apps only), memory of
viewers across streams. Left: voice keys and subscription sign-in to try, computer use on
Windows. Details in [docs/plan.md](docs/plan.md).

## Working on it

```sh
bun install
bun run check                 # TypeScript
bun run build                 # dist/{darwin-arm64,darwin-x64,windows-x64}/piair
bun proto/fake-lightair.ts    # drives PiAir over its pipes like Lightair does, prints timings
bun run sync-tools            # PiAir's Lightair tools from lightair-core's MCP tool table
```

Lightair finds PiAir next to its executable, else `../piair/dist/<target>/piair`; set
`LIGHTAIR_PIAIR=bun` to run this checkout's source instead. The desktop's `cargo xtask bundle`
and `cargo xtask dist` build and bundle it (`dist` signs it with the JIT entitlements Bun needs).

Development aids in Lightair: `LIGHTAIR_PIAIR_PROMPT_FILE=<file>` sends the file's newest line
to PiAir as a prompt (or a command: `!on`, `!off`, `!drives`, `!stop`, `!avatar <name>`,
`!allow <bundle id>`, `!settings <json>`, `!chat <who>: <text>`, `!call <method> <json>`).

Keys come from Lightair's Keychain (the PiAir panel); for development PiAir also reads
`GEMINI_API_KEY`, `CARTESIA_API_KEY` and `ELEVENLABS_API_KEY` from its environment. Never put
keys in files.
