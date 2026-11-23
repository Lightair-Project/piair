// ElevenLabs Flash over the multi-context WebSocket
// (elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input):
// pcm_24000, character alignment turned into mouth shapes.
import { log } from "../protocol.ts";
import { DEFAULT_VOICES } from "../settings.ts";
import { deferred, letterShape, Outbox, type Mark, type Utterance, type Voice } from "./index.ts";

const MODEL = "eleven_flash_v2_5";
const RATE = 24000;

type Ctx = { out: Outbox; done: ReturnType<typeof deferred<void>> };

export class ElevenLabs implements Voice {
  readonly vendor = "elevenlabs" as const;
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private contexts = new Map<string, Ctx>();
  private keepAlive: Timer | null = null;

  constructor(private key: string, private voice: string, private speed: number) {}

  private open(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    const voice = this.voice || DEFAULT_VOICES.elevenlabs;
    if (!voice) return Promise.reject(new Error("ElevenLabs: choose a voice in the co-host's Voice section"));
    this.opening ??= new Promise<WebSocket>((resolve, reject) => {
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voice}/multi-stream-input?model_id=${MODEL}&output_format=pcm_${RATE}&inactivity_timeout=180&sync_alignment=true`;
      const ws = new WebSocket(url, { headers: { "xi-api-key": this.key } } as any);
      ws.onopen = () => {
        this.ws = ws;
        this.opening = null;
        // a context with a space keeps the connection alive between utterances
        this.keepAlive ??= setInterval(() => this.ws?.send(JSON.stringify({ text: " ", context_id: "keepalive" })), 15_000);
        resolve(ws);
      };
      ws.onerror = () => {
        this.opening = null;
        reject(new Error("ElevenLabs: couldn't connect"));
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
    const c = this.contexts.get(m.contextId ?? m.context_id);
    if (!c) return;
    if (m.audio) {
      const marks: Mark[] = [];
      const a = m.alignment ?? m.normalizedAlignment;
      if (a?.chars) {
        a.chars.forEach((ch: string, i: number) => {
          const v = letterShape(ch);
          if (v) marks.push({ t_ms: a.charStartTimesMs[i], v });
        });
      }
      c.out.audio(new Uint8Array(Buffer.from(m.audio, "base64")), RATE, marks);
    }
    if (m.isFinal) {
      c.out.end();
      c.done.resolve();
      this.contexts.delete(m.contextId ?? m.context_id);
    }
    if (m.error) log("warn", "ElevenLabs:", m.error);
  }

  async warm() {
    await this.open().catch((e) => log("warn", e));
  }

  close() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.ws?.send(JSON.stringify({ close_socket: true }));
    this.ws?.close();
  }

  utterance(id: string): Utterance {
    const out = new Outbox(id);
    const ctx: Ctx = { out, done: deferred() };
    this.contexts.set(id, ctx);
    let first = true;
    let chain = Promise.resolve();
    const sendJson = (body: object) => {
      chain = chain
        .then(async () => (await this.open()).send(JSON.stringify(body)))
        .catch((e) => {
          log("warn", e);
          out.end();
          ctx.done.resolve();
        });
    };
    return {
      id,
      say: (piece) => {
        out.markStart();
        if (first) {
          first = false;
          sendJson({ text: " ", context_id: id, voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: this.speed } });
        }
        sendJson({ text: piece + " ", context_id: id, flush: true });
      },
      end: () => sendJson({ context_id: id, close_context: true }),
      cancel: () => {
        out.cancel();
        sendJson({ context_id: id, close_context: true });
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
