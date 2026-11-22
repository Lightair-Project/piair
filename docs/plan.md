# PiAir: plan

Milestones in build order, each with what "done" means. The design is in [design.md](design.md).
Tests are not written by the code writer (project rule); the test writer adds them at the end.

## M0. Design — done

`docs/design.md`, `docs/plan.md`, committed and pushed.

## M1. Prototypes of the three risky parts — done (numbers in design.md)

1. **Pi streams text fast enough to speak.** `proto/stream.ts`: time to first token and first
   sentence through `pi-ai`. Done: numbers in design.md (Gemini free tier: 0.4–1.6 s to the first
   sentence).
2. **Cloud voice with lip sync through `rig::Face` on a real avatar.** PiAir speaks a sentence
   (Gemini TTS here; Cartesia/ElevenLabs when keys exist), Lightair plays it on the "PiAir" track
   and the avatar's mouth follows. Done when a screenshot shows the mouth open mid-word and the
   measured time from request to first sound is recorded.
3. **One computer-use loop.** The model takes a screenshot, moves the real pointer to a target and
   clicks, Lightair's click-zoom reacts. Done when the pointer path and zoom are seen in a
   Lightair screenshot and the per-step times are recorded.

## M2. PiAir runtime

- `src/protocol.ts` (NDJSON both ways, calls with ids and timeouts), `src/main.ts`.
- `src/settings.ts`, `src/secrets.ts` (a Pi `CredentialStore` over `secret.get/set`).
- `src/brain.ts`: providers, model choice, the co-host `Agent`, task agents.
- `src/speech.ts`: sentence splitter, moderation, utterances.
- `src/voice/`: Cartesia, ElevenLabs, Gemini clients behind one interface.
- `src/tools/`: talk, memory, Lightair (same names and methods as the MCP tools), computer.
- `bun run build` makes the three binaries.

Done: `bun src/main.ts` driven by a fake Lightair (`proto/fake-lightair.ts`) answers a chat
message with voice frames, and a prompt with a tool call.

## M3. Desktop: host, voice, face, panel

- `crates/lightair-app/src/piair/` (`mod.rs` host and protocol, `calls.rs` routing into
  `remote_call`, `panel.rs`), `lightair-engine/src/piair_voice.rs` (the voice source),
  `lightair-engine/src/face_drive.rs` (the AI face), a 3-line hook in `avatar.rs`.
- The panel: on/off, status, transcript, prompt box, brain/voice/persona/behaviour settings,
  co-host avatar, AI drives, allowed apps, stop.

Done: in a Release build, turning PiAir on adds the "PiAir" track, a panel prompt makes the
co-host avatar speak with lip sync, chat (Stream Check's test chat or `chat.test`) gets answers.

## M4. Computer use and zoom

- `crates/lightair-app/src/piair/input_mac.rs` (CGEvent, event tap, AX checks, screenshot),
  `input_win.rs` (SendInput, low-level hooks), `lightair-engine/src/zoom_to.rs` and its hook in
  `pointer.rs`, the kill-switch global action.

Done: with AI drives on and the target app allowed, "open a new tab in Safari" works end to end;
touching the mouse pauses it at once; the hotkey kills it; typing into a password field is refused.

## M5. Memory and co-host behaviour

- `src/memory.ts` (notes with caps, SQLite FTS5), `src/director.ts` (scoring, batching,
  chattiness, turn-taking with `streamer` and `heard`), compaction into the stream note.

Done: a viewer who said their name and favourite game an hour ago is greeted by both; PiAir stays
quiet while the streamer talks; chattiness levels change how often it speaks.

## M6. Packaging and polish

- `cargo xtask dist` bundles and signs `piair`; Windows `piair.exe` alongside; `docs/licences.md`.
- UI pass against SESSIONS.md's four questions.

Done: `/Applications/Lightair.app/Contents/MacOS/piair` is signed (codesign --verify --deep
passes) and starts from the panel.

## Later

See design.md §12.
