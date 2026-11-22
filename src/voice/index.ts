// Cloud voices behind one interface. Each utterance streams PCM (s16le mono) to Lightair as
// `voice` messages, with mouth-shape marks when the vendor gives timings.
import { send } from "../protocol.ts";
import type { VoiceVendor } from "../settings.ts";

/** A mouth shape at a time (ms from the start of the chunk it rides with). */
export type Mark = { t_ms: number; v: "A" | "I" | "U" | "E" | "O" | "M" | "rest" };

export interface Utterance {
  readonly id: string;
  /** A text piece to say (in order). */
  say(piece: string): void;
  /** No more pieces. */
  end(): void;
  /** Stop now. */
  cancel(): void;
  /** Settles when the vendor sent the last audio (or failed). */
  readonly finished: Promise<void>;
  /** Time from the first piece to the first audio, ms (once known). */
  firstAudioMs?: number;
}

export interface Voice {
  readonly vendor: VoiceVendor;
  utterance(id: string): Utterance;
  /** Opens connections ahead of time. */
  warm(): Promise<void>;
  close(): void;
}

/** Sends audio for one utterance to Lightair, numbering the pieces. */
export class Outbox {
  private seq = 0;
  private started = 0;
  firstAudioMs?: number;
  cancelled = false;
  constructor(public id: string) {}
  markStart() {
    if (!this.started) this.started = performance.now();
  }
  audio(pcm: Uint8Array, rate: number, marks?: Mark[]) {
    if (this.cancelled || pcm.length === 0) return;
    if (this.firstAudioMs === undefined && this.started) this.firstAudioMs = Math.round(performance.now() - this.started);
    send({ t: "voice", utterance: this.id, seq: this.seq++, rate, pcm: Buffer.from(pcm).toString("base64"), ...(marks?.length ? { marks } : {}) });
  }
  end() {
    if (!this.cancelled) send({ t: "voice_end", utterance: this.id });
  }
  cancel() {
    this.cancelled = true;
    send({ t: "voice_cancel", utterance: this.id });
  }
}

/** A deferred promise. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

// Mouth shapes from phonemes (IPA or ARPAbet) and from letters (for character timings).
const IPA: [RegExp, Mark["v"]][] = [
  [/^(m|b|p|ɱ|M|B|P)$/, "M"],
  [/^(i|iː|ɪ|j|IY|IH|Y)/, "I"],
  [/^(e|eɪ|ɛ|EH|EY)/, "E"],
  [/^(a|aɪ|aʊ|ɑ|ɑː|æ|ʌ|ə|ɐ|AA|AE|AH|AW|AY|ER|ɚ|ɝ)/, "A"],
  [/^(o|oʊ|ɔ|ɔɪ|ɒ|OW|OY|AO)/, "O"],
  [/^(u|uː|ʊ|w|UW|UH|W)/, "U"],
];

export function phonemeShape(p: string): Mark["v"] | null {
  for (const [re, v] of IPA) if (re.test(p)) return v;
  return null;
}

export function letterShape(c: string): Mark["v"] | null {
  const l = c.toLowerCase();
  if ("mbp".includes(l)) return "M";
  if (l === "a") return "A";
  if (l === "e") return "E";
  if (l === "i" || l === "y") return "I";
  if (l === "o") return "O";
  if (l === "u" || l === "w") return "U";
  if (l === " " || /[.,!?;:]/.test(l)) return "rest";
  return null;
}

export async function makeVoice(vendor: VoiceVendor, key: string | undefined, voiceId: string, speed: number, language: string): Promise<Voice | null> {
  if (vendor === "none" || !key) return null;
  if (vendor === "cartesia") return new (await import("./cartesia.ts")).Cartesia(key, voiceId, speed, language);
  if (vendor === "elevenlabs") return new (await import("./elevenlabs.ts")).ElevenLabs(key, voiceId, speed);
  return new (await import("./gemini.ts")).Gemini(key, voiceId);
}
