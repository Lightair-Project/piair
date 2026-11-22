// Gemini TTS (streamGenerateContent, 24 kHz l16). No timings: Lightair's lip sync follows the
// sound itself. Each piece is its own request; up to two run ahead, audio goes out in order.
import { log } from "../protocol.ts";
import { DEFAULT_VOICES } from "../settings.ts";
import { deferred, Outbox, type Utterance, type Voice } from "./index.ts";

/** Gemini's TTS models, best first. Free-tier keys get a few requests per model per day, so a
 * model that answers 429 is skipped for the rest of the run. */
const MODELS = ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-3.8-flash-lite-tts", "gemini-2.5-pro-preview-tts"];
const exhausted = new Set<string>();

export class Gemini implements Voice {
  readonly vendor = "gemini" as const;
  constructor(private key: string, private voice: string) {}
  async warm() {}
  close() {}

  utterance(id: string): Utterance {
    const out = new Outbox(id);
    const done = deferred();
    const controller = new AbortController();
    const queue: Promise<void>[] = [];
    let ended = false;
    let pumping: Promise<void> | null = null;
    const voiceName = this.voice || DEFAULT_VOICES.gemini;
    const key = this.key;

    // one request; its chunks are collected and, when it's the head of the queue, sent live
    type Live = { emit?: (b: Uint8Array) => void; chunks: Uint8Array[] };
    function request(text: string, live: Live): Promise<void> {
      return (async () => {
        let r: Response | null = null;
        for (const model of MODELS.filter((m) => !exhausted.has(m))) {
          r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
            method: "POST",
            signal: controller.signal,
            headers: { "x-goog-api-key": key, "content-type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text }] }],
              generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
            }),
          });
          if (r.status !== 429 && r.status !== 404) break;
          exhausted.add(model);
          log("warn", `voice: ${model} answered ${r.status}; trying the next Gemini voice model`);
        }
        if (!r) throw new Error("Gemini TTS: every model is over its quota for today");
        if (!r.ok || !r.body) throw new Error(`Gemini TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const dec = new TextDecoder();
        let buf = "";
        for await (const part of r.body) {
          buf += dec.decode(part, { stream: true }).replace(/\r/g, "");
          let k: number;
          while ((k = buf.indexOf("\n\n")) >= 0) {
            const ev = buf.slice(0, k);
            buf = buf.slice(k + 2);
            const line = ev.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const j = JSON.parse(line.slice(6));
            for (const p of j.candidates?.[0]?.content?.parts ?? []) {
              if (!p.inlineData?.data) continue;
              const b = new Uint8Array(Buffer.from(p.inlineData.data, "base64"));
              if (live.emit) live.emit(b);
              else live.chunks.push(b);
            }
          }
        }
      })();
    }

    const lives: Live[] = [];
    async function pump() {
      for (let i = 0; i < queue.length || !ended; i++) {
        while (i >= queue.length && !ended) await Bun.sleep(5);
        if (i >= queue.length) break;
        // what came while it waited goes out first, then the rest straight away
        const live = lives[i]!;
        for (const b of live.chunks) out.audio(b, 24000);
        live.chunks = [];
        live.emit = (b) => out.audio(b, 24000);
        await queue[i]!;
        if (out.cancelled) return;
      }
    }

    // the first piece goes at once; later ones gather into one request (fewer requests, same
    // sound: Gemini has no streaming text input)
    let gathered = "";
    const flush = () => {
      if (!gathered) return;
      const text = gathered;
      gathered = "";
      start(text);
    };
    function start(piece: string) {
        const live: Live = { chunks: [] };
        lives.push(live);
        queue.push(request(piece, live).catch((e) => {
          if (!out.cancelled) log("warn", "voice:", e);
        }));
        pumping ??= pump().then(
          () => {
            out.end();
            done.resolve();
          },
          (e) => {
            log("warn", "voice:", e);
            out.end();
            done.resolve();
          },
        );
    }
    return {
      id,
      say(piece) {
        out.markStart();
        if (lives.length === 0) start(piece);
        else {
          gathered += (gathered ? " " : "") + piece;
          if (gathered.length > 280) flush();
        }
      },
      end() {
        flush();
        ended = true;
        if (!pumping) done.resolve();
      },
      cancel() {
        ended = true;
        controller.abort();
        out.cancel();
        done.resolve();
      },
      finished: done.promise,
      get firstAudioMs() {
        return out.firstAudioMs;
      },
    };
  }
}
