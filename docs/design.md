# PiAir: design

PiAir is Lightair's AI co-host. It reads the stream's chat, talks with a cloud voice through an
avatar (lip sync, expressions, gaze), and can use the computer (pointer, keys, Lightair's zoom)
while Lightair shows every move. It is a separate program, written in TypeScript on Bun, built on
Pi's libraries, shipped as one compiled binary inside Lightair.

Status: built on macOS (23 November 2026); see plan.md for what's left. Measured numbers are in
[Measurements](#measurements). The plan and milestones are in [plan.md](plan.md).

## 0. The AI co-host is an object (owner, 23 November 2026)

In Lightair the co-host is an **object**: Add object → **AI co-host** (beside Avatar, its own
Hierarchy icon). It's an avatar object (`lightair_avatar`) whose source settings carry a `cohost`
block, so it takes every avatar type (VRM/GLB, Live2D, Inochi2D, Umamo, PNGtuber) and the avatar
card, Change and Transform come with it:

```json
"cohost": { "on": true, "active": true, "voice_track": "<track id>",
            "piair": { "provider": …, "model": …, "voice": {…}, "persona": {…}, "behaviour": {…} } }
```

- **One active co-host.** PiAir runs while the active co-host's object exists and its On switch is
  on; deleting the object or switching it off stops PiAir. A second co-host says "Another co-host
  is active" and offers Make active.
- **Its settings live on the object** (`cohost.piair`), saved with the project and undoable;
  Lightair passes them to PiAir (`hello.settings`, then `settings` when they change). Keys and
  sign-ins stay in the Keychain.
- **Its voice is a mixer track named after the object** ("AI co-host" by default), made with it;
  removing the object removes the track and renaming the object renames it, in the same undo
  step (`crate::piair::with_cohost_voice`). Only the active co-host's track plays the speech.
- **Its face:** PiAir drives the avatar through `face_drive` instead of a camera (a new co-host
  has no camera); a PNGtuber's mouth follows the level of the co-host's voice track (its `mic`).
- **Hears** (on the object, `cohost.hears: [{track, role}]`): any mixer tracks but co-host
  voices, each heard as **conversation** (people talking to it: it waits while they speak,
  understands them and answers its name; their level is "someone is talking") or **content**
  (something playing, a video or a game: followed as untrusted context, reacted to now and then,
  never taken as someone addressing it). Lightair taps each track's sound
  (`lightair_engine::audio_tap`, 16 kHz mono) into its own on-device speech helper
  (`lightair-speech - -pcm`), or into `piair hear` for a cloud engine (below). Not set: the first
  mic, as conversation. Under each heard track
  the Inspector says how it's going: Listening, the words it last made out, no sound coming in,
  or why it can't hear (the helper's `READY`/`ERROR` lines; a helper that stops is started again
  after five seconds, not in a loop).
- **Mouth** (`cohost.mouth`): `data` (the default: the voice vendor's mouth shapes timed to the
  words, ElevenLabs' and Cartesia's; the sound's loudness where the vendor sends none), `audio`
  (the voice's loudness and brightness alone) or `tracking` (the avatar's own face tracking moves
  the mouth; the voice never does). `face_drive::set_mouth_source`, set by the co-host sync.
- **Hearing with** (`cohost.hearing.conversation` and `.content`: `{engine, model, language}`):
  what turns each kind of track into words, chosen separately.
  - `apple` (the default): Apple's on-device recognizer through `lightair-speech`; free, private,
    one language (`language` given a region, or the system's). It ends an utterance once its words
    stop changing for 1.2 s, since Apple rarely ends one in a stream that never stops.
  - `elevenlabs`: Scribe Live over ElevenLabs' realtime WebSocket (`model` `scribe_v3_live`, the
    default, with `multilang_mode` so a switch between languages mid-sentence is followed, or
    `scribe_v2_realtime`); its own voice detection ends utterances; the language it heard comes
    back. The ElevenLabs key needs Speech to Text.
  - `openrouter`: any OpenRouter transcription model (listed live from its Models API,
    `output_modalities=transcription`, newest first, expired ones left out). OpenRouter's
    speech-to-text doesn't stream, so `piair hear` cuts utterances out by level (60 ms above the
    noise floor to start, 700 ms below to end, 300 ms kept before) and sends each as a WAV.
  - `piair hear` reads one JSON line (`{engine, model, language, key}`: the key never on a command
    line), then 16 kHz mono samples, and writes the helper's lines: `READY`, `TEXT`, `DONE`,
    `LANG`, `ERROR`. Cloud hearing is billed for every second a track is heard.
- **Keys** live in Settings → Connections (one row per service: paste, checked, saved or what's
  wrong). The Voice section lists the vendor's voices; picking one plays a sample on this
  computer, never on stream.
- **Inspector:** the Avatar card with the On switch and the status line, then Talk, Brain,
  Voice, Persona, Behaviour, Framing, Accessories, then Transform, Effects and Canvases.
- **Settings → AI co-host** (about the computer, not an object): AI drives, allowed apps, the
  kill-switch shortcut, and the screenshot rule behind an ⓘ.

The dock panel of the first version is gone; its parts are in the Inspector and Settings.

## 1. Who owns what

| | PiAir (this repo, private) | Lightair desktop (GPL) |
|---|---|---|
| Brain | Pi's `pi-ai` (models, auth, streaming) and `pi-agent-core` (agent loop, tools) | — |
| Co-host behaviour | Choosing which chat to answer, taking turns with the streamer, persona, chattiness | Tells PiAir when the streamer talks (mic level) and what they said (on-device speech) |
| Voice | Streaming cloud TTS (Cartesia, ElevenLabs, Gemini), sentence streaming, timings | Plays it as a **mixer track** ("PiAir"): fader, mute, meters, effects, in the stream and recording |
| Avatar | Mood, expression and gaze cues | Lip sync from the audio it plays, blinks, idle motion, fills **`rig::Face`** for the chosen avatar |
| Computer use | Decides what to do (screenshot → act → check) | Executes it: CGEvent (macOS), SendInput (Windows); every safety switch |
| Zoom | Asks for "zoom to here" | Zooms the screen capture (`pointer.rs` follow-zoom) |
| Memory | Notes per viewer and per stream, SQLite full-text search | — |
| Safety | Moderation before speech, chat as untrusted input, tool gating by who asked | AI-drives mode (off by default), the human always wins, kill switch, app allowlist, no typing into password fields, confirmation of destructive actions |
| Settings UI | Owns its settings file; answers `settings.*` | The PiAir panel (desktop visual language, ⓘ tooltips) |
| Secrets | Asks for them through the protocol | Keychain (macOS) / Credential Manager (Windows) |

Everything viewers see and hear, and every switch that must work if PiAir hangs, is Lightair's.
PiAir can crash, hang or be killed at any time; Lightair keeps streaming, the voice track goes
silent, the avatar returns to its camera (or rest), and the input executor stops.

## 2. Process model and the channel

- Lightair starts PiAir (`Lightair.app/Contents/MacOS/piair`, `piair.exe` next to `lightair.exe`)
  when the panel's switch is on, as a child process with **stdin/stdout pipes**. No port, no
  password: only Lightair can talk to it. PiAir exits when its stdin closes, so it never outlives
  Lightair. stderr is PiAir's log, which Lightair writes to its own log under `piair`.
- Lightair restarts it after a crash (at most 3 times in 5 minutes, then the panel says so).
- The protocol is **newline-delimited JSON**, one message per line, UTF-8, both ways. Audio rides
  in the same stream as base64 (24 kHz mono s16 is 48 kB/s raw, 64 kB/s as base64: nothing for a
  pipe).

### 2.1 Messages, Lightair → PiAir

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `version`, `platform`, `data_dir`, `lightair` (name, version), `settings` (the co-host object's `cohost.piair`) | First line. PiAir applies `settings` over its last ones and answers `ready`. |
| `secrets` | `values: {name: string}` | The keys PiAir asked for (`secret.get`), from the Keychain. Never logged. |
| `chat` | `event` (Lightair's `ChatEvent` JSON: platform, user, roles, text, paid…) | A chat message from any platform Lightair aggregates. |
| `heard` | `text`, `final`, `who` (the track) | What someone said on a track heard as conversation (on-device speech). |
| `content` | `text`, `source` (the track) | What's said on a track heard as content (a video, a game): untrusted context. |
| `secrets_changed` | — | Keys were added or removed in Settings → Connections: read them again. |
| `streamer` | `speaking: bool` | The streamer's mic is above the speech threshold (for turn-taking). |
| `voice_state` | `utterance`, `state: playing\|done\|cancelled`, `queued_ms` | Playback progress. |
| `prompt` | `text` | The streamer typed to PiAir in the panel ("say hi to the raiders", "open OBS settings"). Trusted. |
| `computer` | `ai_drives: bool`, `paused: bool`, `reason` | AI-drives mode changed; paused by human input or the kill switch. |
| `stop` | — | Kill switch: abort the current turn, drop queued speech, stop any computer task. |
| `reply` | `id`, `result` or `error {code, message}` | Answer to a `call`. |
| `settings` | `values` | The panel changed settings (PiAir saves and applies them). |
| `providers` | — | Asks for the provider list again (answered with `providers`). |
| `login` | `provider`, `kind: oauth\|api_key`, `key?` | Sign in to a provider (OAuth runs Pi's flow; `auth` messages follow). |
| `auth_code` | `code` | The code the streamer pasted for a sign-in that asked for one. |
| `voice_key` | — | A voice key was saved in the Keychain: connect the voice again. |

### 2.2 Messages, PiAir → Lightair

| `t` | Fields | Meaning |
|---|---|---|
| `ready` | `version`, `settings` (non-secret), `providers` (id, name, auth kinds, signed in) | PiAir is up. |
| `call` | `id`, `method`, `params` | A Lightair method. Any remote-API method (the same table MCP clients use, `docs/remote-api.md`) plus the PiAir methods below. Answered by `reply`. |
| `voice` | `utterance`, `seq`, `rate`, `pcm` (base64 s16le mono), `marks?` | A piece of speech. `marks`: `[{t_ms, v}]` mouth shapes from the vendor's timings (`v` one of `A I U E O M rest`). |
| `voice_end` | `utterance` | No more pieces for this utterance. |
| `voice_cancel` | `utterance?` | Stop speaking now (all utterances if none given). |
| `face` | `mood?`, `look?: chat\|streamer\|pointer\|camera\|{x,y}`, `brows?`, `nod?` | Non-speech face cues. |
| `status` | `state: idle\|listening\|thinking\|speaking\|acting\|error`, `detail?` | For the panel. |
| `transcript` | `role: viewer\|streamer\|piair\|tool`, `text`, `who?` | The panel's running log. |
| `secret.get` / `secret.set` | `name`, `value?` (as `call`s) | Keychain access for API keys and OAuth tokens. |
| `auth` | `provider`, `url?`, `code?`, `message`, `prompt?`, `options?` (`[{id, label}]`), `done?`, `error?` | An OAuth sign-in step: Lightair opens the URL / shows the code; `prompt` wants a code pasted back (or, with `options`, one chosen) as `auth_code`. |

### 2.3 PiAir's Lightair methods (new, answered only for PiAir)

All coordinates are in the **pixels of the last screenshot** PiAir received; Lightair maps them to
display points (it knows the display and the scale it used).

| Method | Params | Result |
|---|---|---|
| `computer.screenshot` | `display?` (index, default the one under the pointer), `max_width?` (default 1280) | `{image (JPEG base64), width, height, display, cursor: {x,y}}` |
| `computer.move` | `x, y, ms?` | Moves the real pointer along a natural path (minimum-jerk, slight arc, overshoot on long moves). |
| `computer.click` | `x, y, button?, count?, modifiers?` | Moves there, then clicks. |
| `computer.drag` | `from: {x,y}`, `to: {x,y}` | |
| `computer.scroll` | `x, y, dx, dy` | Lines. |
| `computer.type` | `text` | Refused into a password field. |
| `computer.key` | `keys` (e.g. `"cmd+t"`, `"return"`) | Destructive combinations need the streamer's confirmation. |
| `computer.zoom_to` | `x, y, scale?, hold_s?` | Lightair's screen zoom goes there (§6.3). |
| `computer.cursor` | — | Where the pointer is. |
| `avatar.list` | — | Avatars in the workspace: `{id, name, kind}`. |
| `avatar.expression` | `name, weight?` | Sets the co-host avatar's expression (its `expression` setting). |

Every `computer.*` call passes the gates in §7 first; refusals come back as errors with a code
(`not_enabled`, `paused`, `not_allowed_app`, `password_field`, `declined`, `timeout`) that PiAir
turns into a tool error the model can read.

### 2.4 Why not the remote API's WebSocket or MCP

The remote API (port 4455) can be off, can have LAN on, and needs the user's password; a
co-host needs none of that. Calls from PiAir still go through **the same handler** the remote API
uses (`StudioWindow::api_handler`, `crates/lightair-app/src/shell/remote.rs`: a few methods on
the calling thread, the rest through `remote_call` on the main thread) with client `"PiAir"`, so its Lightair tools and the MCP tools are the same methods, undoable and labelled
the same way. The MCP server stays open to outside agents (Claude Code, Codex, Hermes, Goose)
exactly as it is.

## 3. The brain (Pi)

- **Packages:** `@earendil-works/pi-ai` 1.6.0 (unified LLM API, providers, OAuth) and
  `@earendil-works/pi-agent-core` 1.6.0 (`Agent`: tool loop, events, steering). MIT. No
  coding-agent, no TUI.
- **Providers:** registered per provider factory (`@earendil-works/pi-ai/providers/<id>`) so the
  binary stays small: Anthropic, OpenAI, Google, OpenRouter, Groq, Cerebras, xAI, GitHub Copilot,
  plus any OpenAI-compatible URL (Ollama, LM Studio) for people who want one.
- **Auth:** API keys, or subscriptions through Pi's OAuth (`models.login(id, "oauth", …)`):
  Claude Pro/Max, Sign in with ChatGPT, GitHub Copilot, OpenRouter. PiAir's `CredentialStore`
  keeps credentials in Lightair's Keychain through `secret.get/set`; Pi refreshes tokens under its
  lock. Sign-in steps arrive as `auth` messages: Lightair opens the URL in the browser.
- **Where you sign in:** Settings → Connections → Subscriptions, next to the keys, never the
  co-host's Inspector (it only says whether its provider is signed in, with a link there). Lightair
  starts a PiAir of its own for the sign-in, sends it only `login` and `auth_code`, answers only its
  `secret.*` calls, and ends it after its `providers` message; so signing in works with no co-host
  on, and the co-host's PiAir is told `secrets_changed`. Signing out deletes the OAuth credential
  in Lightair (an API key for the same provider stays). Rows: Claude Pro/Max (`anthropic`),
  ChatGPT (`openai`, Pi's Sign in with ChatGPT: OpenAI's models on the subscription), GitHub
  Copilot, SuperGrok/X Premium (`xai`). Anthropic, OpenAI and xAI keep one credential per
  provider: a sign-in replaces a pasted key, and the other way round. So OpenAI is one provider
  in the Brain whether it's a key or ChatGPT; Pi's separate `openai-codex` (Codex models on
  ChatGPT) isn't offered. Sign in with ChatGPT wants a stable id for the install: PiAir makes
  one and keeps it in the Keychain (`device:id`), and introduces itself as Lightair. When the
  co-host's provider isn't signed in but another subscription is, its Brain section offers to
  switch to it.
- **The streamer's AI apps as the brain** (`src/cli.ts`, ported from Ainotra's bridge): Claude
  Code, Codex, Antigravity and Grok on this computer, on their own plans, the supported way. Each
  reply runs the app once in its print mode (`claude -p`, `codex exec --json`, `agy -p`,
  `grok -p`) in an empty scratch folder, with a scrubbed environment (no keys) and none of its
  tools; the conversation so far goes along. Offered as providers `cli:<app>` with the models the
  app's plan offers (its own catalog on disk, or its models command) and its sign-in state (how to
  sign in when it isn't). They talk only: no memory notes, Lightair actions or computer tasks (a
  task asked for says to choose a model provider). Claude Code is the quickest (~750 tokens of
  setup, first words in about 1.4 s); Codex and Antigravity carry ~12–15k tokens of their own.
  Pi's own sign-ins (Settings → Subscriptions) stay alongside.
- **Codex's voice mode for the co-host: tried, not open to other apps (24 November 2026, codex
  0.172).** Codex's app-server has a realtime voice API (`thread/realtime/start`, `appendAudio`,
  `outputAudio/delta`; `--experimental` in its schema, `capabilities.experimentalApi`). On a
  ChatGPT plan: the `websocket` transport answers "realtime conversation requires API key auth"
  (any protocol version); the `webrtc` transport with `version: v3` creates the call and returns
  an SDP answer (ICE-lite servers on UDP 3478), but the servers never answer the connectivity
  checks, from libdatachannel or from Chromium alike, and Codex's own attach to the call
  (`wss://api.openai.com/v1/live/rtc_…`) fails with 404 after about 6 s. Codex Desktop's voice works
  on the same account because the Desktop app sets up the call itself and hands Codex an existing
  call id; that setup isn't exposed, and copying it would be imitating another client (see the
  Ainotra rule above). So realtime voice means a provider API with a key: OpenAI's Realtime API or
  Gemini Live.
  Checked further the same day, with the Codex CLI's working `/voice` session's own log: the CLI
  (and Desktop) create the call themselves, POSTing the offer to
  `chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas` with the
  ChatGPT sign-in token, then start Codex with `transport: {type: "existingCall", callId}`. Driving
  Codex's own helper (`codex-voice-host`: length-prefixed JSON frames, `hello` protocol 1 with the
  package's `sourceCommit`, `startTransport` → offer with TCP candidates, `applyAnswer`) through the
  `webrtc` transport still times out (`transportTimedOut`, then the same 404), with no other voice
  session running. The working route needs Codex's stored ChatGPT token and its private endpoint.
  The owner chose to go on with it (for their own use): **the recipe, proven 24 November 2026 up
  to a connected call on a ChatGPT Plus sign-in** (codex 0.172; from openai/codex, Apache-2.0:
  `tui/src/realtime_call.rs`, `codex-api/src/endpoint/realtime_call.rs`,
  `realtime_websocket/methods_frameless_bidi.rs`, `voice-host/src/transport.rs`):
  1. `codex app-server`: `initialize` (`capabilities.experimentalApi`), `account/read
     {refreshToken: true}` (Codex renews its own sign-in), `thread/start` (ephemeral, read-only,
     scratch folder).
  2. A WebRTC offer with an Opus track and an `oai-events` data channel, **with TCP candidates**
     (this network reaches OpenAI's ICE-lite servers only on TCP 443; UDP 3478 never answers).
  3. `POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`,
     JSON `{sdp, session}`, `session = {instructions, audio: {output: {voice}}, delegation: {type:
     "client"}, model: "gpt-live-1.1-codex"}`; headers `Authorization: Bearer <tokens.access_token
     from ~/.codex/auth.json>`, `chatgpt-account-id`, `openai-alpha: quicksilver=v2`,
     `x-session-id`/`thread-id`: the thread id, `session-id`, `voice-session-id` (a new UUID),
     `originator`. 201: the body is the answer SDP, `Location` ends in the call id (`rtc_…`).
     Without `openai-alpha` the call is created but never connects (that's why the app-server's
     own `webrtc` transport fails).
  4. Apply the answer; when `oai-events` opens, `thread/realtime/start {version: "v3",
     outputModality: "audio", realtimeSessionId: callId, voiceSessionId, includeStartupContext:
     false, clientManagedHandoffs: true, transport: {type: "existingCall", callId}}`.
  5. Audio travels **on the WebRTC call** (Opus both ways): Codex's side rejects
     `input_audio.append` on a call. `codex-voice-host` only joins the call to the Mac's own mic and
     speakers, so Lightair needs its own peer to put the heard tracks in and take the voice out.
     **Proven end to end 24 November 2026** on a ChatGPT Plus sign-in, in a compiled Bun binary:
     PiAir's own WebRTC peer (`node-datachannel` 0.33 with `enableIceTcp`, `opusscript` for Opus)
     makes the offer with TCP candidates, the call is created, the session started on it; a test
     voice in was transcribed right and Codex answered in voice (21.6 s of Opus over the call). So
     PiAir holds the call; `codex-voice-host` isn't needed. Audio each way is 48 kHz stereo Opus in
     RTP (payload type 111): heard PCM up, Codex's voice down, decoded and sent to Lightair as the
     usual `voice` messages (the mouth follows the sound). `node-datachannel`'s `.node` addon loads
     only in the compiled binary, not under `bun run`.
- **Realtime voice** (`src/realtime.ts`, `src/realtime-mode.ts`; voice vendor `codex`): the live
  model hears and speaks over the call instead of the text brain + speech-to-text + text-to-speech.
  On when the co-host's voice is "ChatGPT voice"; Lightair streams the heard conversation audio as
  `audio` messages (16 kHz mono s16le, base64), PiAir upsamples to 48 kHz stereo Opus up the call,
  and the model's voice comes back as the usual `voice` messages (48 kHz mono; no marks, so the
  mouth follows the sound; quiet frames dropped so it rests between lines). Barge-in: a `streamer
  speaking` message clears the outgoing buffer. It uses the streamer's own Codex ChatGPT sign-in
  (`~/.codex/auth.json`) the Codex CLI's way, off by default, for their own machine; there is no
  supported API. Works on every target: `scripts/build.ts` embeds the matching
  `@node-datachannel/<platform>` addon per build (`src/ndc.ts` is swapped in; the host platform's
  package is in node_modules, a cross-target one fetched from npm), and opusscript is WASM.
- **The page the sign-in comes back to** (Pi's local callback server) is Lightair's, not Pi's:
  `scripts/build.ts` builds `src/oauth-page.ts` in place of pi-ai's `utils/oauth-page.js`.
  Pi's flows are built into the binary (`@earendil-works/pi-ai/bun-oauth`), and PiAir answers
  their terminal questions for a desktop (browser login, github.com).
- **Which models:** Pi's catalog is fixed at a pi-ai release (old models, none newer).
  `src/catalog.ts` asks each provider for its current list where there's a key or sign-in
  (OpenRouter's public list always): models it no longer lists are left out, new ones are added
  (made from the closest catalog model, so they're called the same way), newest first by the
  provider's dates. Without a list: the catalog newest first by version, without dated snapshots.
  Never offered: speech, image, embedding, research and batch-only models. Lists are fetched after
  `ready` (the panel's list is replaced when they come) and again when keys change, at most every
  30 minutes.
- **Identity:** `identity: { attribution: { name: "Lightair PiAir", url: "https://lightair.app" } }`.
- **Two agents:**
  - **The co-host** (talking): a rolling conversation, short replies, no thinking (`reasoning:
    "minimal"`), only talk tools and safe Lightair tools. Its text output *is* speech.
  - **Tasks** (computer use, multi-step Lightair work): a fresh `Agent` per task with the computer
    and Lightair tools, append-only history for its life, then a one-line result handed back to
    the co-host. Each task's transcript stays append-only (Claude's guidance: never prune
    screenshots mid-task; all tool results of a turn go back in one user message, which Pi's
    Anthropic conversion does). Images are capped at 20 per request by starting a new task
    segment with a summary when a task runs long.
- **Context management** for a stream that lasts hours: the co-host's transcript is compacted at
  quiet moments (no speech for 20 s and > 60 % of the window): old turns become a short summary
  appended to the stream's notes (§8). Compaction is the only time the prefix changes, so prompt
  caching holds between compactions.

## 4. Co-host behaviour

### 4.1 Inputs and priorities

The **director** (`src/director.ts`) collects inputs and decides when the co-host takes a turn:

| Input | Trusted | Default behaviour |
|---|---|---|
| Panel prompt (`prompt`) | yes | Answer at once (interrupts own speech). |
| Streamer speech (`heard`, final) addressed to PiAir (its name, or a question right after PiAir spoke) | yes | Answer at once. |
| Paid messages, raids, new members | no | Thank, within ~5 s. |
| Chat mentioning PiAir's name, or a question | no | Candidate. |
| Other chat | no | Candidate with low weight; batched. |

Every chat message gets a score (mention ×3, question ×2, paid ×4, first message from this viewer
×1.5, moderator ×1.2, duplicates and spam ×0). Candidates wait in a window; when the director may
speak, it takes the best few (up to 5) as one turn: "Recent chat:" plus the messages, and the
model replies to one or two of them, or says nothing (`[skip]`).

### 4.2 Taking turns

- Never starts talking while the streamer speaks (`streamer.speaking`), and waits 700 ms after
  they stop. If the streamer starts talking while PiAir speaks, PiAir finishes the sentence and
  stops (setting: "Stop when I talk", on by default).
- **Chattiness** (setting, 0–3): quiet (only when addressed), normal (addressed + best chat every
  ≥ 45 s), lively (every ≥ 20 s), chatterbox (every ≥ 8 s).
- One utterance at a time; a new trusted request cancels queued speech (`voice_cancel`).

### 4.3 Persona

Settings: name (default "Pi"), personality (free text, a few presets), language, voice, content
rules ("family friendly" on by default), what it may do (Lightair actions, computer use). The
system prompt is built from these plus fixed rules (§7.1). Replies are written to be spoken:
short sentences, no markdown, no emoji, numbers and names said naturally.

## 5. Voice and lip sync

### 5.1 Pipeline

```
model text deltas ─► sentence splitter ─► moderation ─► TTS (streaming WS) ─► voice{pcm, marks}
                                                                            │
Lightair: voice source (paced, 48 kHz) ─► mixer track "PiAir" ─► program / recording
              └─► envelope + marks ─► face driver ─► rig::Face of the co-host avatar
```

- **Sentence splitter:** cuts at `.`, `!`, `?`, `…`, and line ends; the first piece also cuts at a
  comma or dash after ≥ 40 characters, so the voice starts sooner. Pieces go to one TTS context
  with "continue" so the prosody flows across sentences (Cartesia `continue: true`, ElevenLabs
  multi-context).
- **TTS vendors** (`src/voice/`), each a small WebSocket or HTTP client on Bun's built-in
  `WebSocket`/`fetch` (no SDK needed, smaller binary; protocols from the vendors' docs):
  - **Cartesia Sonic** (primary): WebSocket, raw `pcm_s16le` 24 kHz, **phoneme timestamps** → mouth
    shapes. Documented model latency under 90 ms, ~140 ms first byte measured by third parties.
  - **ElevenLabs Flash** (fallback): multi-context WebSocket, `pcm_24000`, **character alignment**
    → mouth shapes by a letter rule.
  - **Gemini TTS** (works with a Gemini API key, no timings): `streamGenerateContent`, 24 kHz l16.
- **Lip sync is driven by the sound itself** in Lightair, so every vendor works and the mouth can
  never drift from the voice: the voice source computes a fast RMS envelope (10 ms windows, attack
  15 ms / release 60 ms) and a simple brightness measure (zero-crossing rate) as it plays each
  block. `mouth_open` follows the envelope (gated, compressed); `mouth_wide` follows brightness
  ("ee"/"ih" bright → wide, "oo"/"oh" dark → round). When the vendor sent `marks`, the vowel at the
  playing position sets `mouth_wide` instead and `M` (m/b/p) closes the mouth.
- **Face driver** (`lightair-engine/src/face_drive.rs`): per avatar source, the AI's face, with
  blinks every 2–6 s, small idle head motion (breathing nod, slow sway), saccades, a gaze target
  (chat panel side, the streamer, the pointer), mood brows, and nods on sentence ends. Merged in
  the avatar's tick (`avatar.rs` `video_tick`): with no camera face, the AI face is used whole;
  with a camera face, the camera keeps head and eyes and the AI drives the mouth while it speaks.
  It goes through the avatar's own `Smoother` like a tracked face, so every avatar type (VRM/GLB,
  Live2D, Inochi2D, Umamo, PNGtuber) takes it unchanged.

### 5.2 Mixer track

A new libobs source type, `lightair_piair_voice` (input, audio), like `lightair_test_tone`
(`audio_host.rs:72`): a thread paces queued PCM out in 10 ms blocks at 48 kHz float planar with
`os_gettime_ns` timestamps. Turning PiAir on the first time adds the source to the workspace and a
track named "PiAir" (`Command::AddSource` + `AddTrack`, as the mixer's "add track" does). The
streamer gets fader, mute, effects, monitoring and meters like any track. Resampling 24 → 48 kHz is
linear interpolation with a short low-pass (speech, inaudible difference).

## 6. Computer use

### 6.1 Loop

A task is "do X on the computer" from the streamer (panel or voice). The task agent has:
`screenshot`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `key`, `zoom_to`,
`wait`, plus the Lightair tools. Screenshots are JPEG, ≤ 1280 px wide (Claude's guidance: 1280×720
class images; coordinates in the image's pixel space). Each action returns a fresh screenshot
after the UI settles (150 ms, or longer after a click that opens something), so the model checks
its work every step. Works with any provider whose model takes images; the generic tools are used
for all of them. Anthropic's native `computer_toolset_20260801` is a later option when Pi passes
provider-native tools through (§12).

### 6.2 Moving the real pointer

Lightair's executor moves the real system cursor along a natural path: minimum-jerk timing
(10t³ − 15t⁴ + 6t⁵), a slight arc (2–6 % of the distance, random side), duration from Fitts' law
(250–900 ms), a small overshoot and settle on moves over 600 px, 120 Hz steps. Because Lightair's
drawn pointer and click-zoom already follow the real system cursor
(`lightair-engine/src/pointer.rs`), viewers see a smooth styled pointer and the click-zoom
reacts on its own.

### 6.3 Zoom to here

`computer.zoom_to {x, y, scale, hold_s}` sets a zoom request in the engine
(`lightair-engine/src/zoom_to.rs`) that every pointer filter with zoom on honours in
`zoom_tick`: in to the point at `scale` (default the look's zoom scale), held for `hold_s`
(default 4 s), then out as usual. The model uses it to show viewers something without clicking.
Errors with `no_zoom` when no screen capture with zoom is on air.

## 7. Safety

### 7.1 In PiAir

- **Chat is untrusted data.** It reaches the model only inside a fenced block (`<chat
  untrusted="true">`, with `<` and `>` in messages escaped), never as instructions. The system
  prompt says chat can ask, never command.
- **Capabilities by who asked.** A turn caused by chat can only talk, remember and read (state,
  chat history). Lightair actions that change anything and every computer action need a trusted
  turn (the streamer, by panel or voice). Enforced in code (`beforeToolCall` blocks by turn source),
  not by the prompt.
- **Moderation before speech:** every sentence passes a fast local check (slur and abuse lists,
  personal data like emails, phone numbers and street addresses, links, repeated characters)
  before it goes to TTS; a sentence that fails is dropped and the turn is cut. Optional strict mode
  adds a model check per sentence (a small, fast model) at ~150 ms extra.
- **Never reads out** viewer-provided links, codes or long numbers; never repeats a message it was
  asked to repeat verbatim.
- **Memory hygiene:** notes are written by the model about viewers, never copied from chat
  verbatim; capped (§8).

### 7.2 In Lightair (works even if PiAir hangs)

- **AI-drives mode** is off by default and never turns itself on; the panel switch turns it on for
  this session only (it's off again after Lightair restarts). Without it every `computer.*` call
  except `screenshot` and `cursor` fails with `not_enabled`.
- **The human always wins.** A listen-only event tap watches mouse and keyboard; events Lightair
  posts carry a tag (`kCGEventSourceUserData`), so anything untagged is the human. Any human event
  pauses the AI at once: the move in progress stops between two steps, keys held are released,
  and `computer` `{paused: true}` goes to PiAir. It resumes after 3 s without human input. On
  Windows, low-level hooks see `LLMHF_INJECTED`/`LLKHF_INJECTED` and Lightair's own
  `dwExtraInfo` tag.
- **Kill switch:** a global hotkey (default ⌃⌥⌘K, Ctrl+Alt+K on Windows, changeable in Settings
  → Shortcuts) turns AI-drives off, cancels speech and sends `stop`. If PiAir doesn't stop within
  1 s, Lightair kills the process. A stop button in the panel does the same.
- **App allowlist:** the AI may only act in apps on the list (bundle IDs / executable names; empty
  by default, the panel adds the frontmost app or picks from running apps). Checked for the
  frontmost app and for the app under the click point. Lightair itself is never on it.
- **Screenshots show only what the AI may touch:** `computer.screenshot` works only while AI
  drives is on, and the picture sent to the model keeps only the visible parts of the allowed
  apps' windows; everything else (other apps, Lightair, the menu bar, the Dock, the desktop, the
  round corners of windows) is black, worked out from the window list (`CGWindowListCopyWindowInfo`,
  front to back). The panel shows a camera glyph for a few seconds after each picture, with the
  provider it went to behind it. (Free tiers may train on what they're sent: another reason to keep
  pictures to the allowed apps.)
- **No typing into password fields:** `computer.type` and `computer.key` are refused when secure
  keyboard entry is on (`IsSecureEventInputEnabled`) or the focused element is a secure text field
  (`AXSecureTextField`).
- **Confirm destructive actions:** key combinations that quit, close, delete or empty (⌘Q, ⌘W,
  ⌘⌫, ⇧⌘⌫, ⌥⌘⎋, Alt+F4, Shift+Delete…), and clicks on elements whose accessibility title says
  delete, remove, erase, discard, quit, send, post, publish, buy, pay or confirm, wait for the
  streamer's yes in the panel (30 s, then refused).
- Rate limit: at most 15 actions per second; a task runs at most 5 minutes without a new trusted
  prompt.

## 8. Memory (Hermes-style, PiAir's own code)

Borrowing the idea from Hermes Agent: small, bounded, agent-curated notes plus searchable history.
No Hermes code.

- **Where:** `<data_dir>/PiAir/` (Lightair passes `data_dir`): `memory/viewers/<platform>/<id>.md`,
  `memory/streams/<YYYY-MM-DD>.md`, `memory/persona.md`, and `piair.sqlite`.
- **Caps:** a viewer note ≤ 600 characters, a stream note ≤ 2,000, the persona note ≤ 1,500. A
  write that would go over fails with the current note and asks the model to rewrite it shorter
  (curation instead of growth).
- **Tools:** `remember {about: "viewer"|"stream"|"self", who?, note, replace?}` and
  `recall {query, who?}` (SQLite FTS5 over chat history and notes, top 8 with dates).
- **Automatic context:** when a viewer's message is in a turn, their note (if any) rides along;
  the stream note and persona note are in the system prompt.
- **History:** every chat message, streamer line and PiAir line goes into `chat` (FTS5) with
  stream date, platform, viewer id. Kept 90 days (setting).

## 9. Settings

The co-host's settings live on its object (`cohost.piair`, §0); PiAir keeps the last ones it was
given in `<data_dir>/PiAir/settings.json` (no secrets). The computer's (AI drives, allowed apps)
are Lightair's, in `<data_dir>/PiAir/lightair.json` and Settings → AI co-host; the kill-switch
shortcut is in Settings → Shortcuts.

| Group | Settings |
|---|---|
| Brain | provider, model, sign-in (API key or subscription) |
| Voice | vendor, voice, speed |
| Persona | name, personality, language, family friendly |
| Behaviour | chattiness, answer chat, stop when I talk, listen to me (on-device speech) |
| Avatar (the object) | the avatar it uses (Change), On |
| Computer (Settings → AI co-host) | AI drives (this session), allowed apps, kill-switch shortcut |

Label and value only; explanations sit behind ⓘ.

## 10. Latency budget

Target: **first sound under ~1 s** from the moment a turn starts (streamer stops talking, prompt
sent, chat picked).

| Step | Budget | Notes |
|---|---|---|
| Director → request sent | 15 ms | context assembly, memory lookup (SQLite, local) |
| Model, first sentence | 300–450 ms | fast models (Claude Haiku 5.5, Gemini Flash-Lite paid tier, Groq/Cerebras); first piece cut at a comma |
| Moderation (local) | < 1 ms | strict mode +150 ms |
| TTS first audio | 90–150 ms | Cartesia / ElevenLabs Flash over a warm WebSocket |
| Pipe + Lightair buffer + audio engine + output | 40–70 ms | 10 ms blocks, audio engine 5 ms blocks |
| **Total** | **~450–750 ms** | |

The TTS WebSocket is opened when PiAir starts and kept warm (ping every 20 s). Measured numbers
with what's available on this machine are below.

## 11. Packaging, signing, licensing

- **Build:** `bun build --compile --minify --bytecode --target=bun-<t> src/main.ts --outfile
  dist/<t>/piair` for `darwin-arm64`, `darwin-x64-baseline`, `windows-x64-baseline` (like Pi's
  `scripts/build-binaries.sh`: `--no-compile-autoload-bunfig --no-compile-autoload-dotenv`).
  `bun run build` builds all three.
- **Into Lightair:** the desktop's `cargo xtask dist` copies `../piair/dist/darwin-<arch>/piair`
  to `Lightair.app/Contents/MacOS/piair` (when present) and signs it with the app's identity,
  hardened runtime and the JIT entitlements Bun needs (`allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`). Windows: `piair.exe` next to
  `lightair.exe`, signed with the same certificate. Development runs find it at
  `../piair/dist/<t>/piair` or run `bun ../piair/src/main.ts` (`LIGHTAIR_PIAIR=bun`).
- **Licensing:** PiAir is open source under the MIT licence (MoonGoblin), like Pi. Dependencies
  are MIT (Pi) or similarly permissive; `bun pm ls` audit in `docs/licences.md`. Lightair (GPL) and PiAir are
  separate programs talking over a pipe; the desktop's PiAir module (GPL, in the desktop repo)
  only speaks the protocol. Nothing goes into lightair-core.

## 12. Later

- Anthropic's native `computer_toolset_20260801` and Gemini's `computer_use` tool when Pi passes
  provider-native tools through; set-of-marks from the accessibility tree for small targets.
- Cloud speech-to-text (streaming) where on-device recognition doesn't cover the language.
- PiAir on the phones (Lightair Live), if ever: the protocol would run over `lightair-link`.
- lightair-core: expose `lightair_remote::mcp` `TOOLS` as JSON so PiAir takes the MCP tool list at
  runtime instead of keeping its own copy (`docs/public-repo-changes.md`).

## Measurements

Measured on the owner's Mac (Apple silicon), 23 November 2026, over home internet. Only a Gemini
API key is available on this machine (free tier, rate limited, "high demand" 503s at times);
Cartesia and ElevenLabs need keys the owner adds.

**Pi streaming text** (`proto/stream.ts`, `pi-ai` `google` provider, `reasoning: minimal`, two
spoken sentences):

| Model | First token (ms) | First sentence (ms) | Whole reply (ms) |
|---|---|---|---|
| gemini-3.5-flash-lite | 1341 / 670 / 836 | 1341 / 1085 / 836 | 1342 / 1095 / 853 |
| gemini-3.1-flash-lite | 1648 / 1087 / 426 | 1648 / 1088 / 426 | 1649 / 1089 / 481 |
| gemini-flash-lite-latest | 1326 / 1601 / 703 | 1326 / 1601 / 703 | 1327 / 1601 / 771 |
| gemini-3.8-flash | 503 (overloaded) | | |

Gemini delivers short replies in one or two chunks, so first token ≈ whole reply. Pi adds no
measurable time of its own; the wait is the provider's.

**Gemini TTS, streamed** (`proto/tts-gemini.ts`, `gemini-3.8-flash-tts`, one 5–6 s sentence):
first audio 813 / 719 / 976 ms, whole sentence 1.7–1.9 s (faster than real time), 24 kHz l16
mono. `gemini-3.8-flash-lite-tts` hit the free tier's limit of 3 requests.

**Synthetic input on macOS** (`proto/input/*.swift`): posting mouse events works for a process with
Accessibility; the HID idle clock (`CGEventSourceSecondsSinceLastEventType`) counts posted events
too and updates about once a second, so it **cannot** tell the human from the AI. A listen-only
event tap does: 20 of 20 tagged events came back with the tag; untagged posted events carry the
poster's PID (hardware events carry 0). The human-always-wins check is built on the tap.

**Voice and lip sync through `rig::Face` on a real avatar** (a development build of Lightair, a
VRM avatar with no face in its camera, Gemini TTS): the "PiAir" track appears in the mixer when
PiAir is turned on, the voice plays on it, and the mouth follows the sound (frames every 0.45 s:
closed before speech, opening and closing with the syllables, the head swaying, the `[happy]` mood
switching the VRM's happy expression on). Time from the prompt to the first sentence: 1.05–1.3 s
on good runs, 3–5 s while Gemini was overloaded; first audio 1.0–1.4 s after the first sentence
(Gemini TTS, including 429 retries on the free tier's 10-a-day limit). With Cartesia or
ElevenLabs (90–150 ms) and a fast model, the budget in §10 applies; those keys weren't available.

**Computer use** (the same build, AI drives on, TextEdit allowed): asked in the panel to type in
an empty TextEdit document, PiAir looked at the screen, moved the real pointer along its path,
clicked into the document and typed "Hello from PiAir." in about 10 s from the prompt (three model
turns with screenshots, two actions). Lightair's click-zoom zoomed the stream's screen capture in
2× on PiAir's click and back out after its hold; `computer.zoom_to` zoomed it 2.5× into the asked
point and out again after 6 s. Touching the mouse while AI drives was on showed "Paused: you're in
control" at once.

**Memory across runs** (`proto/memory-check.ts`, Gemini Flash-Lite): a viewer wrote "I'm Maya…
my favourite game is Stardew Valley and I have a cat called Biscuit"; after the turn PiAir kept
the note "Maya (kiwi_bird), first-time viewer. Likes Stardew Valley. Has a cat named Biscuit." A
new PiAir process on the same data folder, asked "do you remember my cat's name and what game I
love?", answered from the note: "…you love Stardew Valley and your cat's name is Biscuit!" (Without
the note, an earlier run found it through `recall` over the full-text history.) The model didn't
call `remember` on its own, so the director now updates a viewer's note after any turn in which
they said something about themselves (one short model call, off the reply's path, moderated, capped).

**Turn-taking** (`proto/director-check.ts`, Pi's faux provider, plain chat every 3 s): quiet never
spoke; chatty spoke at 0.3, 8.4, 16.4 and 24.5 s; lively at 0.3 and 20.4 s; quiet answered its
name at once (2.1 s, the message came at 2 s); a mention while the streamer talked until 6 s was
answered at 6.8 s (0.7 s after they stopped).

**Screenshot privacy** (Release build, TextEdit allowed): without AI drives `computer.screenshot`
is refused; with it, the picture the model received showed only TextEdit's two windows on black
(no Lightair, other apps, menu bar or Dock). One display only on this Mac: a second display is
handled by the same code (the display under the pointer; black if its visible frame can't be
found) but wasn't tried.

**Not measured yet:** Cartesia and ElevenLabs (no keys on the build machine), subscription
sign-in, anything on Windows.

Lessons: small models (Gemini Flash-Lite) sometimes say "on it" without calling the tool, and copy
that from their own history; the director now runs a streamer's action request as a task when the
reply promised it but called nothing. A task's result says what really happened (a model claimed
"I've typed it" after its tools failed).
