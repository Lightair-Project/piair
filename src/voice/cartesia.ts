// Cartesia Sonic over its WebSocket (docs.cartesia.ai/api-reference/tts/websocket): raw pcm_s16le
// 24 kHz, one context per utterance with `continue` so sentences flow, phoneme timestamps turned
// into mouth shapes.
import { log } from "../protocol.ts";
import { deferred, Outbox, phonemeShape, type Mark, type Utterance, type Voice } from "./index.ts";

const VERSION = "2026-08-14";
const MODEL = "sonic-3.6";
const RATE = 24000;

type Ctx = { out: Outbox; done: ReturnType<typeof deferred<void>>; bytes: number; pendingMarks: Mark[] };

export class Cartesia implements Voice {
  readonly vendor = "cartesia" as const;
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private contexts = new Map<string, Ctx>();
  private ping: Timer | null = null;
  private voice: string;

  constructor(private key: string, voice: string, private speed: number, private language: string) {
    this.voice = voice;
  }

  private async voiceId(): Promise<string> {
    if (this.voice) return this.voice;
    // the account's first voice (stock voices are listed for every account)
    const r = await fetch("https://api.cartesia.ai/voices?limit=1", { headers: { "X-API-Key": this.key, "Cartesia-Version": VERSION } });
    const j: any = await r.json().catch(() => ({}));
    const list = Array.isArray(j) ? j : (j.data ?? []);
    this.voice = list[0]?.id ?? "";
    if (!this.voice) throw new Error("Cartesia: no voice to use; pick one in PiAir's settings");
    return this.voice;
  }

  private open(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.opening ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`wss://api.cartesia.ai/tts/websocket?cartesia_version=${VERSION}`, { headers: { "X-API-Key": this.key } } as any);
      ws.onopen = () => {
        this.ws = ws;
        this.opening = null;
        this.ping ??= setInterval(() => (ws as any).ping?.(), 20_000);
        resolve(ws);
      };
      ws.onerror = () => {
        this.opening = null;
        reject(new Error("Cartesia: couldn't connect"));
      };
      ws.onclose = () => {
        this.ws = null;
        for (const c of this.contexts.values()) {
          c.out.end();
          c.done.resolve();
        }
        this.contexts.clear();
      };
      ws.onmessage = (e) => this.onMessage(String(e.data));
    });
    return this.opening;
  }

  private onMessage(text: string) {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    const c = this.contexts.get(m.context_id);
    if (!c) return;
    if (m.type === "chunk" && m.data) {
      const pcm = new Uint8Array(Buffer.from(m.data, "base64"));
      const startMs = (c.bytes / 2 / RATE) * 1000;
      const endMs = startMs + (pcm.length / 2 / RATE) * 1000;
      // marks that fall in this chunk, relative to its start
      const marks = c.pendingMarks.filter((k) => k.t_ms >= startMs && k.t_ms < endMs).map((k) => ({ ...k, t_ms: Math.round(k.t_ms - startMs) }));
      c.pendingMarks = c.pendingMarks.filter((k) => k.t_ms >= endMs);
      c.bytes += pcm.length;
      c.out.audio(pcm, RATE, marks);
    } else if (m.type === "phoneme_timestamps" && m.phoneme_timestamps) {
      const { phonemes = [], start = [] } = m.phoneme_timestamps;
      phonemes.forEach((p: string, i: number) => {
        const v = phonemeShape(p);
        if (v) c.pendingMarks.push({ t_ms: start[i] * 1000, v });
      });
    } else if (m.type === "done") {
      c.out.end();
      c.done.resolve();
      this.contexts.delete(m.context_id);
    } else if (m.type === "error") {
      log("warn", "Cartesia:", m.error ?? m.message ?? text.slice(0, 200));
      c.out.end();
      c.done.resolve();
      this.contexts.delete(m.context_id);
    }
  }

  async warm() {
    await this.open().catch((e) => log("warn", e));
  }

  close() {
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
  }

  utterance(id: string): Utterance {
    const out = new Outbox(id);
    const ctx: Ctx = { out, done: deferred(), bytes: 0, pendingMarks: [] };
    this.contexts.set(id, ctx);
    let chain = Promise.resolve();
    const lang = languageCode(this.language);
    const sendJson = (body: object) => {
      chain = chain.then(async () => {
        const ws = await this.open();
        ws.send(JSON.stringify(body));
      }).catch((e) => {
        log("warn", e);
        out.end();
        ctx.done.resolve();
      });
    };
    const base = async () => ({
      model_id: MODEL,
      voice: { mode: "id", id: await this.voiceId() },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: RATE },
      language: lang,
      context_id: id,
      add_phoneme_timestamps: true,
      ...(this.speed !== 1 ? { generation_config: { speed: this.speed } } : {}),
    });
    return {
      id,
      say: (piece) => {
        out.markStart();
        chain = chain.then(async () => {
          const ws = await this.open();
          ws.send(JSON.stringify({ ...(await base()), transcript: piece + " ", continue: true }));
        }).catch((e) => {
          log("warn", e);
          out.end();
          ctx.done.resolve();
        });
      },
      end: () => {
        chain = chain.then(async () => {
          const ws = await this.open();
          ws.send(JSON.stringify({ ...(await base()), transcript: "", continue: false }));
        }).catch(() => ctx.done.resolve());
      },
      cancel: () => {
        out.cancel();
        sendJson({ context_id: id, cancel: true });
        this.contexts.delete(id);
        ctx.done.resolve();
      },
      finished: ctx.done.promise,
      get firstAudioMs() {
        return out.firstAudioMs;
      },
    };
  }
}

function languageCode(language: string): string {
  const map: Record<string, string> = { english: "en", spanish: "es", french: "fr", german: "de", portuguese: "pt", japanese: "ja", korean: "ko", chinese: "zh", italian: "it", dutch: "nl", indonesian: "id", hindi: "hi", russian: "ru", polish: "pl", turkish: "tr", swedish: "sv" };
  return map[language.trim().toLowerCase()] ?? (language.length === 2 ? language.toLowerCase() : "en");
}
