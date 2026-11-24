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
/** The utterance the model's voice is streaming into now (one per reply). */
let utterance: string | null = null;
let seq = 0;
/** The model is speaking (from its transcript stream): the call's audio is forwarded only then. */
let speaking = false;

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

/** The model started/stopped speaking (its transcript stream): start the voice utterance on the
 * first word, end it after the last. Between replies nothing is forwarded, so the mouth rests. */
function onSpeaking(active: boolean) {
  if (active === speaking) return;
  speaking = active;
  if (active) {
    utterance = `rt-${Date.now()}`;
    seq = 0;
    send({ t: "status", state: "speaking" });
  } else if (utterance) {
    send({ t: "voice_end", utterance });
    utterance = null;
    send({ t: "status", state: "listening" });
  }
}

/** The model's voice (48 kHz mono) → a `voice` message Lightair plays (no marks: the mouth follows
 * the sound). Forwarded only while the model is speaking, as one continuous utterance — so there are
 * no clicks within a reply and silence between replies isn't sent. */
function onVoice(pcm: Int16Array) {
  if (!speaking || !utterance) return;
  send({ t: "voice", utterance, seq: seq++, rate: 48000, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
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
        onSpeaking,
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

/** The streamer started talking: interrupt the model and cut what it's saying now (barge-in). */
export function interrupt() {
  session?.interrupt();
  if (utterance) {
    send({ t: "voice_cancel", utterance });
    utterance = null;
    speaking = false;
  }
}

export async function stop(): Promise<void> {
  const s = session;
  session = null;
  if (utterance) {
    send({ t: "voice_end", utterance });
    utterance = null;
  }
  speaking = false;
  await s?.stop();
}
