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
/** The model's answer to the briefing ("Okay") is kept off the air: a reply that starts before
 * anyone has said or typed anything, soon after the call comes up. */
let upAt = 0;
let spoken = false;
let offAir = false;

export function isOn(): boolean {
  return settings.get().voice.vendor === "codex";
}

export function running(): boolean {
  return session !== null;
}

/** The briefing said into the call as it comes up: the model takes its identity from this (not
 * from the instruction fields). Framed as stage directions so it doesn't answer it as if someone
 * named the co-host had spoken. */
function brief(): string {
  const p = settings.get().persona;
  return [
    `[Stage directions from the show's producer. Nobody said this out loud: don't answer it or mention it, just take on the role.]`,
    `For the rest of this conversation you ARE ${p.name}, the streamer's co-host on a live stream. ${p.name} is your name and your identity. When anyone asks your name or who you are, you say you're ${p.name}.`,
    `You never call yourself ChatGPT, an assistant or an AI made by OpenAI; you never mention ChatGPT or OpenAI. Nobody else in this conversation is called ${p.name}: that's you.`,
    `${p.name}'s personality: ${p.personality}`,
    `Always speak ${p.language}.`,
    p.familyFriendly ? "Keep it family friendly: no swearing, nothing sexual or gory." : "",
    "Talk with the streamer and their chat like a co-host: warm, quick, natural, never like an assistant offering help or menus. One or two short sentences. Wait for someone to talk to you; if there's nothing worth saying, stay quiet. You only ever speak as yourself, never for the streamer or anyone else.",
    "Acknowledge these directions with only the word \"Okay\" and nothing else.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The co-host's spoken instructions for the live model. */
function instructions(): string {
  const p = settings.get().persona;
  return [
    `Your name is ${p.name}. You are a live-stream co-host with your own identity — NOT ChatGPT, not an AI assistant, not a Codex or OpenAI product. Never say you are ChatGPT or an assistant or mention OpenAI. If asked who you are, you are ${p.name}, the streamer's co-host.`,
    `You talk out loud through an avatar, in your own voice, as ${p.name}.`,
    `Your personality: ${p.personality}`,
    `Always speak ${p.language}.`,
    p.familyFriendly ? "Keep it family friendly: no swearing, nothing sexual or gory." : "",
    "You are on a live stream with the streamer and their chat. Talk to them like a co-host — warm, quick, natural — not like an assistant offering to help. Keep replies to one or two short sentences. Don't offer menus of things you can do. If there's nothing worth saying, stay quiet.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The model started/stopped speaking (its transcript stream): start the voice utterance on the
 * first word, end it after the last. Between replies nothing is forwarded, so the mouth rests. */
function onSpeaking(active: boolean) {
  if (active === speaking) return;
  speaking = active;
  if (active && !spoken && upAt && Date.now() - upAt < 8000) {
    offAir = true;
    return;
  }
  if (offAir) {
    if (!active) offAir = false;
    return;
  }
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
      (upAt = 0), (spoken = false), (offAir = false);
      if (!codexBin) throw new Error("Codex isn't installed: realtime voice uses your ChatGPT plan through the Codex app");
      session = await startRealtime({
        instructions: instructions(),
        brief: brief(),
        voice: settings.get().voice.voice || "cove",
        codexBin,
        cwd: settings.piairDir(),
        onVoice,
        onSpeaking,
        onTranscript: (role, text) => {
          if (role !== "piair") spoken = true;
          else if (offAir) return;
          // PIAIR_DEBUG=1: what the model heard and said, in the log (checks)
          if (process.env.PIAIR_DEBUG) log("info", `realtime ${role}: ${text}`);
          send({ t: "transcript", role, text });
        },
        onStatus: (state, detail) => {
          // the call is up and briefed
          if (state === "listening" && !upAt) upAt = Date.now();
          send({ t: "status", state, ...(detail ? { detail } : {}) });
        },
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

/** The streamer typed to the co-host (the Talk box): say it into the call. */
export function prompt(text: string) {
  spoken = true;
  session?.sendText(text);
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
