// `piair hear`: hearing one mixer track with a cloud speech-to-text, for Lightair (one process per
// heard track, like its on-device helper `lightair-speech`, and with the same lines out).
//
// stdin: one line of JSON, {engine, model, language, key}, then the track's sound: 16 kHz mono
// 16-bit little-endian samples, until Lightair closes it.
// stdout, one line each:
//   READY <what's listening>     it's listening
//   TEXT <words so far>          what's been said in this utterance so far
//   DONE                         the utterance ended (the last TEXT is what was said)
//   LANG <code>                  the language it heard last (when the engine says)
//   ERROR <why>                  it can't hear right now (it keeps trying)
//
// Engines:
//   elevenlabs   Scribe Live over a WebSocket: words as they're said, utterances ended by its own
//                voice detection; v3 Live follows a switch between languages mid-sentence.
//   openrouter   any transcription model on OpenRouter: one request per utterance, which this
//                file cuts out of the sound by its level (OpenRouter's speech-to-text doesn't stream).

export {};

const RATE = 16_000;

type Config = { engine: string; model?: string; language?: string; key?: string };

function say(line: string) {
  process.stdout.write(line.replace(/\s*\n\s*/g, " ") + "\n");
}

let lastError = "";
function problem(why: string) {
  if (why === lastError) return;
  lastError = why;
  say(`ERROR ${why}`);
}

interface Engine {
  push(pcm: Int16Array): void;
}

// ---------------------------------------------------------------- ElevenLabs Scribe Live

class Scribe implements Engine {
  private ws: WebSocket | null = null;
  private open = false;
  private pending: Int16Array[] = [];
  private pendingLen = 0;
  private retryMs = 1_000;
  private lastCommitted = "";
  private lastCommitAt = 0;

  constructor(private cfg: Config) {
    this.connect();
  }

  private connect() {
    const model = this.cfg.model || "scribe_v3_live";
    const q = new URLSearchParams({
      model_id: model,
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      vad_silence_threshold_secs: "0.7",
      // the language comes back with each committed utterance
      include_timestamps: "true",
    });
    // v3 Live: a switch between languages mid-sentence is followed
    if (model === "scribe_v3_live") q.set("multilang_mode", "true");
    if (this.cfg.language) q.set("language_code", this.cfg.language);
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${q}`, {
      headers: { "xi-api-key": this.cfg.key ?? "" },
    } as any);
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
    };
    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (m.message_type) {
        case "session_started":
          this.retryMs = 1_000;
          lastError = "";
          say(`READY elevenlabs ${model}${this.cfg.language ? ` ${this.cfg.language}` : " any language"}`);
          break;
        case "partial_transcript":
          if (m.text) say(`TEXT ${m.text}`);
          break;
        case "committed_transcript":
        case "committed_transcript_with_timestamps": {
          if (m.language_code) say(`LANG ${m.language_code}`);
          const text = String(m.text ?? "").trim();
          // with timestamps on, the same utterance may come in both forms: once is enough
          if (!text || (text === this.lastCommitted && Date.now() - this.lastCommitAt < 2_000)) break;
          this.lastCommitted = text;
          this.lastCommitAt = Date.now();
          say(`TEXT ${text}`);
          say("DONE");
          break;
        }
        case "auth_error":
          this.retryMs = 30_000;
          problem("ElevenLabs didn't accept the key: give it Speech to Text in ElevenLabs › Developers › API keys");
          break;
        case "quota_exceeded":
          this.retryMs = 60_000;
          problem("ElevenLabs credits are used up");
          break;
        case "unaccepted_terms":
          this.retryMs = 60_000;
          problem("Accept ElevenLabs' speech-to-text terms on elevenlabs.io first");
          break;
        case "insufficient_audio_activity":
        case "warning":
          break;
        default:
          if (m.error) problem(`ElevenLabs: ${m.error}`);
      }
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      this.open = false;
      this.ws = null;
      if (ev.code !== 1000 && !lastError) problem(`ElevenLabs closed the connection (${ev.code}${ev.reason ? `: ${ev.reason}` : ""}); trying again`);
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 60_000);
    };
  }

  push(pcm: Int16Array) {
    this.pending.push(pcm);
    this.pendingLen += pcm.length;
    // a tenth of a second at a time
    if (this.pendingLen < RATE / 10) return;
    const all = concat(this.pending, this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    if (!this.open || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: Buffer.from(all.buffer, all.byteOffset, all.byteLength).toString("base64"),
        commit: false,
        sample_rate: RATE,
      }),
    );
  }
}

// ---------------------------------------------------------------- OpenRouter, one request per utterance

/** Cuts utterances out of the sound by its level: speech starts after 60 ms above the noise floor
 * (plus 12 dB), ends after 700 ms below it or at 28 s; 300 ms before the start is kept. */
class Utterances {
  private frame: number[] = [];
  private preroll: Int16Array[] = [];
  private speech: Int16Array[] = [];
  private loudFrames = 0;
  private quietFrames = 0;
  private voicedFrames = 0;
  private inSpeech = false;
  private floor = -60;
  private static FRAME = RATE / 50; // 20 ms

  constructor(private done: (pcm: Int16Array) => void) {}

  push(pcm: Int16Array) {
    for (const s of pcm) {
      this.frame.push(s);
      if (this.frame.length === Utterances.FRAME) {
        this.onFrame(Int16Array.from(this.frame));
        this.frame = [];
      }
    }
  }

  private onFrame(f: Int16Array) {
    let sum = 0;
    for (const s of f) sum += s * s;
    const db = 10 * Math.log10(sum / f.length / (32768 * 32768) + 1e-12);
    // the noise floor follows quiet quickly and loud slowly
    this.floor = db < this.floor ? this.floor + (db - this.floor) * 0.2 : this.floor + (db - this.floor) * 0.002;
    const loud = db > Math.max(this.floor + 12, -50);
    if (!this.inSpeech) {
      this.preroll.push(f);
      if (this.preroll.length > 15) this.preroll.shift();
      this.loudFrames = loud ? this.loudFrames + 1 : 0;
      if (this.loudFrames >= 3) {
        this.inSpeech = true;
        this.speech = [...this.preroll];
        this.preroll = [];
        this.quietFrames = 0;
        this.voicedFrames = this.loudFrames;
      }
      return;
    }
    this.speech.push(f);
    if (loud) {
      this.quietFrames = 0;
      this.voicedFrames++;
    } else this.quietFrames++;
    if (this.quietFrames >= 35 || this.speech.length >= 50 * 28) {
      const enough = this.voicedFrames >= 20; // 400 ms of speech, not a cough
      const all = concat(this.speech, this.speech.length * Utterances.FRAME);
      this.inSpeech = false;
      this.speech = [];
      this.loudFrames = 0;
      this.voicedFrames = 0;
      if (enough) this.done(all);
    }
  }
}

class OpenRouter implements Engine {
  private cut: Utterances;
  private queue: Promise<void> = Promise.resolve();
  private model: string;

  constructor(private cfg: Config) {
    this.model = cfg.model || "openai/gpt-4o-transcribe";
    this.cut = new Utterances((pcm) => {
      this.queue = this.queue.then(() => this.transcribe(pcm));
    });
    if (!cfg.key) problem("No OpenRouter key: add one in Settings → Connections");
    else say(`READY openrouter ${this.model}${cfg.language ? ` ${cfg.language}` : " any language"}`);
  }

  push(pcm: Int16Array) {
    this.cut.push(pcm);
  }

  private async transcribe(pcm: Int16Array) {
    if (!this.cfg.key) return;
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        input_audio: { data: wav(pcm).toString("base64"), format: "wav" },
      };
      if (this.cfg.language) body.language = this.cfg.language;
      const r = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://lightair.app",
          "X-Title": "Lightair",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error?.message ?? `it answered ${r.status}`;
        problem(r.status === 401 ? "OpenRouter didn't accept the key" : r.status === 402 ? "OpenRouter credits are used up" : `OpenRouter: ${msg}`);
        return;
      }
      lastError = "";
      const text = String(j.text ?? "").trim();
      if (j.language) say(`LANG ${j.language}`);
      if (text) {
        say(`TEXT ${text}`);
        say("DONE");
      }
    } catch (e) {
      problem(`OpenRouter: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ---------------------------------------------------------------- helpers

function concat(parts: Int16Array[], len: number): Int16Array {
  const out = new Int16Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p.subarray(0, Math.min(p.length, len - at)), at);
    at += p.length;
    if (at >= len) break;
  }
  return out;
}

/** 16 kHz mono 16-bit samples as a WAV file. */
function wav(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---------------------------------------------------------------- stdin: the config, then sound

let engine: Engine | null = null;
let head = Buffer.alloc(0);
let odd: number | null = null;

for await (const chunk of Bun.stdin.stream()) {
  let bytes = Buffer.from(chunk);
  if (!engine) {
    head = Buffer.concat([head, bytes]);
    const nl = head.indexOf(10);
    if (nl < 0) continue;
    let cfg: Config;
    try {
      cfg = JSON.parse(head.subarray(0, nl).toString("utf8"));
    } catch {
      say("ERROR bad configuration from Lightair");
      process.exit(2);
    }
    engine = cfg.engine === "openrouter" ? new OpenRouter(cfg) : new Scribe(cfg);
    bytes = head.subarray(nl + 1);
  }
  // samples are two bytes: a chunk may split one
  if (odd !== null) {
    bytes = Buffer.concat([Buffer.from([odd]), bytes]);
    odd = null;
  }
  if (bytes.length % 2) {
    odd = bytes[bytes.length - 1]!;
    bytes = bytes.subarray(0, bytes.length - 1);
  }
  if (bytes.length) {
    const copy = new Int16Array(bytes.length / 2);
    for (let i = 0; i < copy.length; i++) copy[i] = bytes.readInt16LE(i * 2);
    engine.push(copy);
  }
}
process.exit(0);
