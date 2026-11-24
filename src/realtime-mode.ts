// Realtime voice mode (voice vendor "codex"): the co-host hears and speaks through ChatGPT's live
// model over a call (src/realtime.ts), instead of the text brain + speech-to-text + text-to-speech
// path. Owned here and switched on from settings; Lightair sends the heard audio as `audio`
// messages and plays the model's voice from the usual `voice` messages.
import { findBinary } from "./cli.ts";
import { log, send } from "./protocol.ts";
import { startRealtime, type Realtime } from "./realtime.ts";
import * as settings from "./settings.ts";

let session: Realtime | null = null;
let starting = false;
/** The utterance the model's voice is streaming into now (a new one after a pause). */
let utterance: string | null = null;
let seq = 0;
let lastVoiceAt = 0;
let endTimer: ReturnType<typeof setTimeout> | null = null;

export function isOn(): boolean {
  return settings.get().voice.vendor === "codex";
}

export function running(): boolean {
  return session !== null;
}

/** The co-host's spoken instructions for the live model. */
function instructions(): string {
  const p = settings.get().persona;
  return [
    `You are ${p.name}, the AI co-host of a live stream, talking out loud through an avatar with your own voice.`,
    `Personality: ${p.personality}`,
    `Speak ${p.language}.`,
    p.familyFriendly ? "Keep it family friendly: no swearing, nothing sexual or gory." : "",
    "Keep replies short and natural, one or two sentences. You are on a stream, so talk to the streamer and the chat, not like an assistant. If there's nothing to say, stay quiet.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Ends the current voice utterance after a short silence, so the mouth rests between lines. */
function scheduleEnd() {
  if (endTimer) clearTimeout(endTimer);
  endTimer = setTimeout(() => {
    if (utterance) {
      send({ t: "voice_end", utterance });
      utterance = null;
    }
  }, 400);
}

/** The model's voice (48 kHz mono) → a `voice` message Lightair plays (no marks: mouth follows sound).
 * The call carries continuous audio, so quiet frames (comfort noise between lines) are dropped: the
 * utterance ends and the mouth rests until the model speaks again. */
function onVoice(pcm: Int16Array) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  const rms = Math.sqrt(sum / pcm.length);
  if (rms < 160) return; // about -46 dBFS: silence or comfort noise
  if (!utterance) {
    utterance = `rt-${Date.now()}`;
    seq = 0;
  }
  lastVoiceAt = Date.now();
  send({ t: "voice", utterance, seq: seq++, rate: 48000, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
  scheduleEnd();
}

/** Brings realtime voice into step with the settings: on when the vendor is "codex", off otherwise. */
export async function apply(): Promise<void> {
  if (isOn()) {
    if (session || starting) return;
    starting = true;
    try {
      const codexBin = await findBinary("codex");
      if (!codexBin) throw new Error("Codex isn't installed: realtime voice uses your ChatGPT plan through the Codex app");
      session = await startRealtime({
        instructions: instructions(),
        voice: settings.get().voice.voice || "cove",
        codexBin,
        cwd: settings.piairDir(),
        onVoice,
        onTranscript: (role, text) => send({ t: "transcript", role, text }),
        onStatus: (state, detail) => send({ t: "status", state, ...(detail ? { detail } : {}) }),
        onError: (message) => send({ t: "status", state: "error", detail: message }),
      });
    } catch (e) {
      log("warn", "realtime:", e);
      send({ t: "status", state: "error", detail: e instanceof Error ? e.message : String(e) });
      session = null;
    } finally {
      starting = false;
    }
  } else if (session) {
    await stop();
  }
}

export function pushAudio(pcm: Int16Array) {
  session?.pushAudio(pcm);
}

/** The streamer started talking: interrupt the model (barge-in). */
export function interrupt() {
  session?.interrupt();
}

export async function stop(): Promise<void> {
  const s = session;
  session = null;
  if (endTimer) clearTimeout(endTimer);
  if (utterance) {
    send({ t: "voice_end", utterance });
    utterance = null;
  }
  void lastVoiceAt;
  await s?.stop();
}
