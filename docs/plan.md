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

## M2. PiAir runtime — done

- `src/protocol.ts` (NDJSON both ways, calls with ids and timeouts), `src/main.ts`.
- `src/settings.ts`, `src/secrets.ts` (a Pi `CredentialStore` over `secret.get/set`).
- `src/brain.ts`: providers, model choice, the co-host `Agent`, task agents.
- `src/speech.ts`: sentence splitter, moderation, utterances.
- `src/voice/`: Cartesia, ElevenLabs, Gemini clients behind one interface.
- `src/tools/`: talk, memory, Lightair (same names and methods as the MCP tools), computer.
- `bun run build` makes the three binaries.

Done: `bun src/main.ts` driven by a fake Lightair (`proto/fake-lightair.ts`) answers a chat
message with voice frames, and a prompt with a tool call.

## M3. Desktop: host, voice, face, panel — done (desktop commits 1957064, 01aad76, 5485978, local)

- `crates/lightair-app/src/piair/` (`mod.rs` host and protocol, `calls.rs` routing into
  `remote_call`, `panel.rs`), `lightair-engine/src/piair_voice.rs` (the voice source),
  `lightair-engine/src/face_drive.rs` (the AI face), a 3-line hook in `avatar.rs`.
- The panel: on/off, status, transcript, prompt box, brain/voice/persona/behaviour settings,
  co-host avatar, AI drives, allowed apps, stop.

Done: in a Release build, turning PiAir on adds the "PiAir" track, a panel prompt makes the
co-host avatar speak with lip sync, chat (Stream Check's test chat or `chat.test`) gets answers.

## M4. Computer use and zoom — done on macOS; Windows to do

- `crates/lightair-app/src/piair/input_mac.rs` (CGEvent, event tap, AX checks, screenshot),
  `input_win.rs` (SendInput, low-level hooks), `lightair-engine/src/zoom_to.rs` and its hook in
  `pointer.rs`, the kill-switch global action.

Done: with AI drives on and the target app allowed, "open a new tab in Safari" works end to end;
touching the mouse pauses it at once; the hotkey kills it; typing into a password field is refused.

## M5. Memory and co-host behaviour — done (checks in design.md, Measurements)

- `src/memory.ts` (notes with caps, SQLite FTS5), `src/director.ts` (scoring, batching,
  chattiness, turn-taking with `streamer` and `heard`), compaction into the stream note.

Done: a viewer who said their name and favourite game an hour ago is greeted by both; PiAir stays
quiet while the streamer talks; chattiness levels change how often it speaks.

## M6. Packaging and polish — done: bundled, signed, installed; panel UI pass done

- `cargo xtask dist` bundles and signs `piair`; Windows `piair.exe` alongside; `docs/licences.md`.
- UI pass against SESSIONS.md's four questions.

Done: `/Applications/Lightair.app/Contents/MacOS/piair` is signed (codesign --verify --deep
passes) and starts from the panel.

## Still to do (23 November 2026)

- **Windows computer use:** not built: it must be compiled and tried on Windows, and unverified
  safety code is worse than the clear refusal Windows gives now (`computer.*` answers
  `unsupported`, "Computer use isn't available on this system yet"). The spec for a Windows
  session is below, under "Windows executor".
- **Voice keys (owner):** the Cartesia and ElevenLabs clients follow their documented WebSocket
  protocols but haven't run (no keys on the build machine). Add a key in the PiAir panel
  (Settings → Voice key), then check: the default Cartesia voice (the account's first), the
  phoneme and character marks moving the mouth, first audio under ~150 ms.
- **Subscription sign-in (owner):** Pi's OAuth (Claude Pro/Max, ChatGPT, GitHub Copilot) is wired
  to the panel's "Use subscription" button and code prompt but unrun; it needs the owner's account.
- **Second display:** handled by the same code as the first; not tried (one display here).
- **Synthetic scroll in GPUI apps:** CGEvent wheel and drag events didn't reach Lightair's own
  panels in tests; other apps take them as far as known (unverified).
- **lightair-core:** expose MCP's tool table as JSON so PiAir needn't keep a synced copy
  (`bun run sync-tools`).

## Windows executor (spec for a Windows session)

Where: `lightair/crates/lightair-app/src/piair/input_win.rs`, behind `#[cfg(windows)]`, with
`computer.rs` calling it the way it calls `input_mac` (the gates, the coordinate mapping, the rate
limit, the destructive-action confirmation and the path generation in `path.rs` are shared and
stay as they are). Crates already in the app: `windows` 0.62 and `windows-sys` 0.61 (add the
features named below). Done when every check in M4 passes on Windows 11 in a Release build.

1. **Posting input:** `SendInput` with `INPUT_MOUSE` (`MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE |
   MOUSEEVENTF_VIRTUALDESK`, coordinates normalised to 0–65535 over the virtual desktop;
   `LEFTDOWN/UP`, `RIGHTDOWN/UP`, `MIDDLEDOWN/UP`; `MOUSEEVENTF_WHEEL` / `HWHEEL` with
   `WHEEL_DELTA` per line) and `INPUT_KEYBOARD` (virtual keys for named keys and modifiers;
   `KEYEVENTF_UNICODE` with the UTF-16 unit as `wScan` for typing, so any layout works). Every
   event's `dwExtraInfo` is Lightair's tag, `0x5069_4169` ("PiAi"), as on macOS.
   Process DPI awareness must be per-monitor v2 so the coordinates are physical pixels.
2. **The human always wins:** low-level hooks on their own thread with a message loop
   (`SetWindowsHookExW(WH_MOUSE_LL)` and `WH_KEYBOARD_LL`). In the callbacks an event is the
   human's unless it's injected *and* carries Lightair's tag: `MSLLHOOKSTRUCT.flags &
   LLMHF_INJECTED` with `dwExtraInfo == TAG`, and `KBDLLHOOKSTRUCT.flags & LLKHF_INJECTED` with
   `dwExtraInfo == TAG`. A human event stamps the time `since_human()` reads (an atomic, as on
   macOS). Hooks must return within the system timeout (do nothing in them but the stamp; always
   `CallNextHookEx`). If the hooks can't be installed, AI drives refuses to turn on.
3. **Password fields:** UI Automation (`IUIAutomation::GetFocusedElement`,
   `UIA_IsPasswordPropertyId`): `computer.type` and non-shortcut `computer.key` are refused when
   the focused element is a password field. If UI Automation can't answer, refuse too.
4. **What's where:** the app under a point: `WindowFromPoint` → `GetAncestor(GA_ROOT)` →
   `GetWindowThreadProcessId` → `QueryFullProcessImageNameW`; the allowlist holds executable names
   (`notepad.exe`). The foreground app: `GetForegroundWindow`, same path. Never Lightair's own
   process. Button words for the confirmation: UI Automation `ElementFromPoint`, its `Name` and
   `HelpText`.
5. **Screenshots with the same privacy rules:** capture the monitor under the pointer
   (`MonitorFromPoint`; DXGI Desktop Duplication, or GDI `BitBlt` from the screen DC as the
   simple first version), then black out everything but the visible parts of the allowed apps'
   windows: walk top-level windows front to back (`EnumWindows` order, visible, not cloaked:
   `DwmGetWindowAttribute(DWMWA_CLOAKED)`, real frame: `DWMWA_EXTENDED_FRAME_BOUNDS`), allowed
   windows show, every other window covers; the taskbar and anything outside the monitor's work
   area (`GetMonitorInfoW`, `rcWork`) are black; if the work area can't be found, the whole
   picture is black. Only while AI drives is on; the panel's camera glyph as on macOS.
6. **Kill switch:** already cross-platform (`GlobalAction::PiAirStop`, Ctrl+Alt+K on Windows
   through `RegisterHotKey`); check it on Windows.
7. **Bundling:** `cargo xtask dist` on Windows already copies `piair.exe` next to
   `lightair.exe` (`piair_binary`); sign it with the same certificate as the app.

## Later

See design.md §12.
