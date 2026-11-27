// PiAir's voice is Lightair's: each piece of text goes to Lightair (`say`), which speaks it with
// the co-host's voice on its mixer track, lip sync included (Lightair's built-in voices). Only the
// realtime mode (realtime-mode.ts) sends audio itself.
import { send } from "./protocol.ts";

export interface Utterance {
  readonly id: string;
  /** A text piece to say (in order). */
  say(piece: string): void;
  /** No more pieces. */
  end(): void;
  /** Stop now. */
  cancel(): void;
  /** Settles when Lightair has played it out (or it was cancelled). */
  readonly finished: Promise<void>;
  /** Time from the first piece to the first sound, ms (once known). */
  firstAudioMs?: number;
}

export interface Voice {
  utterance(id: string): Utterance;
}

type Waiting = { resolve: () => void; started: number; utt: { firstAudioMs?: number } };
const waiting = new Map<string, Waiting>();

/** Lightair's playback progress (`voice_state`), for the utterances said through it. */
export function onVoiceState(utterance: string, state: string) {
  const w = waiting.get(utterance);
  if (!w) return;
  if (state === "playing" && w.utt.firstAudioMs === undefined && w.started) w.utt.firstAudioMs = Math.round(performance.now() - w.started);
  if (state === "done" || state === "cancelled") {
    waiting.delete(utterance);
    w.resolve();
  }
}

/** Lightair speaks: the co-host's voice is chosen and keyed in Lightair. */
export class LightairVoice implements Voice {
  utterance(id: string): Utterance {
    let resolve!: () => void;
    const finished = new Promise<void>((r) => (resolve = r));
    let said = false;
    let ended = false;
    const utt: Utterance & { firstAudioMs?: number } = {
      id,
      say(piece) {
        if (ended || !piece.trim()) return;
        if (!said) waiting.get(id)!.started = performance.now();
        said = true;
        send({ t: "say", utterance: id, text: piece });
      },
      end() {
        if (ended) return;
        ended = true;
        if (!said) {
          waiting.delete(id);
          resolve();
          return;
        }
        send({ t: "say_end", utterance: id });
      },
      cancel() {
        ended = true;
        send({ t: "say_cancel", utterance: id });
        waiting.delete(id);
        resolve();
      },
      finished,
    };
    waiting.set(id, { resolve, started: 0, utt });
    return utt;
  }
}
