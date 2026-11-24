// Realtime voice through the streamer's ChatGPT plan (Sign in with ChatGPT, the Codex CLI's way).
// PiAir holds the WebRTC call itself and OpenAI's live model hears and speaks directly: no separate
// speech-to-text, text model or text-to-speech. Proven end to end on a ChatGPT Plus sign-in
// (docs/design.md). The co-host's heard audio goes up the call; the model's voice comes back as
// Opus, decoded and sent to Lightair as ordinary `voice` messages (the mouth follows the sound).
//
// The call is created the Codex CLI's way: `codex app-server` creates the thread and starts the
// session on the call, and the call itself is a POST to ChatGPT's backend with the Codex sign-in
// (`~/.codex/auth.json`). This uses the streamer's own Codex login, as their CLI does; it is
// off by default and only for their own machine (there's no supported API for it).
//
// node-datachannel's native addon is embedded per platform by scripts/build.ts (src/ndc.ts), so
// realtime voice works on every target PiAir ships to; it loads only from the compiled binary.
import rtc from "./ndc.ts";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./protocol.ts";

const OPUS_PT = 111;
const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const MODEL = "gpt-live-1.1-codex";

export interface RealtimeOptions {
  /** The co-host's spoken instructions (persona, rules, language). */
  instructions: string;
  /** The persona briefing said into the call once it's up (what the model actually follows). */
  brief: string;
  /** An OpenAI realtime voice id (e.g. "cove", "marin"). */
  voice: string;
  /** Codex's binary, to run its app-server (the CLI brain found it). */
  codexBin: string;
  /** A scratch folder for the (read-only, ephemeral) thread. */
  cwd: string;
  /** The model's voice, 48 kHz mono s16le, as it arrives. */
  onVoice(pcm: Int16Array): void;
  /** What was said, for the Talk log: role "streamer" (heard) or "piair" (the co-host). */
  onTranscript(role: "streamer" | "piair", text: string): void;
  onStatus(state: string, detail?: string): void;
  onError(message: string): void;
  /** The model started (true) or finished (false) speaking, from its own transcript stream. The
   * voice audio is forwarded only while this is true, so each reply is one unbroken utterance. */
  onSpeaking(active: boolean): void;
}

export interface Realtime {
  /** Heard audio (16 kHz mono s16le) to send up the call. */
  pushAudio(pcm: Int16Array): void;
  /** Interrupt the model (the streamer started talking). */
  interrupt(): void;
  /** A typed message from the streamer, said into the call as a user turn. */
  sendText(text: string): void;
  stop(): Promise<void>;
}

/** Codex's ChatGPT sign-in tokens, kept by its CLI. */
async function codexTokens(): Promise<{ access: string; account: string }> {
  const raw = JSON.parse(await readFile(join(homedir(), ".codex", "auth.json"), "utf8"));
  const t = raw.tokens ?? raw;
  if (!t?.access_token) throw new Error("No ChatGPT sign-in for Codex: run `codex login` in Terminal");
  return { access: t.access_token, account: t.account_id ?? "" };
}

export async function startRealtime(opts: RealtimeOptions): Promise<Realtime> {
  if (!rtc) throw new Error("Realtime voice runs only in the built app, not a development run.");
  const OpusScript = (await import("opusscript")).default;

  const app = spawn(opts.codexBin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  let nextId = 0;
  const waiting = new Map<number, (m: any) => void>();
  let buf = "";
  app.stdout!.on("data", (d) => {
    buf += d;
    let k: number;
    while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id && waiting.has(m.id)) {
        waiting.get(m.id)!(m);
        waiting.delete(m.id);
      } else onNote(m);
    }
  });
  const req = (method: string, params: any) => {
    const id = ++nextId;
    app.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    return new Promise<any>((r) => waiting.set(id, r));
  };
  const note = (method: string, params?: any) => app.stdin!.write(JSON.stringify({ method, ...(params !== undefined ? { params } : {}) }) + "\n");

  const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  let speakingTail: ReturnType<typeof setTimeout> | null = null;
  function onNote(m: any) {
    const meth = m.method as string | undefined;
    // the model's transcript streams while it talks: open the voice on the first word and close it a
    // short tail after the last, so the whole reply plays as one utterance (no loudness guessing).
    if (meth === "thread/realtime/transcript/delta" && m.params?.role === "assistant") {
      if (speakingTail) {
        clearTimeout(speakingTail);
        speakingTail = null;
      }
      opts.onSpeaking(true);
    } else if (meth === "thread/realtime/transcript/done") {
      const role = m.params?.role === "assistant" ? "piair" : "streamer";
      const text = String(m.params?.text ?? "").trim();
      if (text) opts.onTranscript(role, text);
      if (role === "piair") {
        if (speakingTail) clearTimeout(speakingTail);
        speakingTail = setTimeout(() => opts.onSpeaking(false), 500);
      }
    } else if (meth === "thread/realtime/error") {
      opts.onError(String(m.params?.message ?? "the voice call failed"));
    } else if (meth === "thread/realtime/closed") {
      opts.onStatus("idle");
    }
  }

  // --- our WebRTC peer, with ICE-TCP (OpenAI's media servers are reached over TCP here)
  const pc = new rtc.PeerConnection("piair", { iceServers: ["stun:stun.l.google.com:19302"], enableIceTcp: true });
  const audio = new rtc.Audio("0", "SendRecv");
  audio.addOpusCodec(OPUS_PT);
  const ssrc = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
  audio.addSSRC(ssrc, "realtime", "realtime", "audio-" + ssrc);
  const track = pc.addTrack(audio);
  pc.createDataChannel("oai-events");

  // the model's voice in (48 kHz stereo Opus → 48 kHz mono s16le), passed on as each packet comes:
  // Lightair's voice source holds a short lead, which evens out the network's unevenness (a timer
  // here drifted, and its catching up dropped sound)
  track.onMessage((pkt: Buffer) => {
    const b = Buffer.from(pkt);
    const cc = b[0]! & 0x0f;
    const x = (b[0]! >> 4) & 1;
    let off = 12 + cc * 4;
    if (x) off += 4 + b.readUInt16BE(off + 2) * 4;
    if (off >= b.length) return;
    let stereo: Buffer;
    try {
      stereo = dec.decode(b.subarray(off));
    } catch {
      return;
    }
    const s = new Int16Array(stereo.buffer, stereo.byteOffset, stereo.byteLength / 2);
    const mono = new Int16Array(s.length / 2);
    for (let i = 0; i < mono.length; i++) mono[i] = (s[i * 2]! + s[i * 2 + 1]!) >> 1;
    opts.onVoice(mono);
  });

  const offer: string = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out gathering the call")), 15000);
    pc.onGatheringStateChange((g: string) => {
      if (g === "complete") {
        clearTimeout(timer);
        resolve(pc.localDescription().sdp);
      }
    });
    pc.setLocalDescription();
  });

  opts.onStatus("starting");
  const tokens = await codexTokens();
  await req("initialize", { clientInfo: { name: "lightair-piair", title: "Lightair", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  note("initialized");
  const thread = (await req("thread/start", {
    cwd: opts.cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
    // the model is Codex and identifies as ChatGPT by default: the persona has to be set firmly, on
    // the thread and again at the realtime start
    baseInstructions: opts.instructions,
    developerInstructions: opts.instructions,
  })).result.thread;
  const voiceSession = crypto.randomUUID();
  const session = { instructions: opts.instructions, audio: { output: { voice: opts.voice } }, delegation: { type: "client" }, model: MODEL };
  const resp = await fetch(CALL_URL, {
    method: "POST",
    body: JSON.stringify({ sdp: offer, session }),
    headers: {
      Authorization: "Bearer " + tokens.access,
      "chatgpt-account-id": tokens.account,
      "Content-Type": "application/json",
      "openai-alpha": "quicksilver=v2",
      "x-session-id": thread.id,
      "voice-session-id": voiceSession,
      "session-id": thread.sessionId ?? thread.id,
      "thread-id": thread.id,
      originator: "lightair_piair",
    },
  });
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 200);
    app.kill();
    try {
      pc.close();
    } catch {}
    throw new Error(resp.status === 401 ? "ChatGPT didn't accept the Codex sign-in; sign in again in Codex" : `the call couldn't be created (${resp.status}): ${body}`);
  }
  const answer = await resp.text();
  const location = resp.headers.get("location") ?? "";
  const callId = location.split("?")[0]!.replace(/\/$/, "").split("/").pop() ?? "";
  pc.setRemoteDescription(answer, "answer");
  await req("thread/realtime/start", {
    threadId: thread.id,
    outputModality: "audio",
    version: "v3",
    realtimeSessionId: callId,
    voiceSessionId: voiceSession,
    includeStartupContext: false,
    clientManagedHandoffs: true,
    realtimeStartInstructions: opts.instructions,
    transport: { type: "existingCall", callId },
  });
  // the model ignores the instruction fields but takes its identity from a conversation turn, so
  // brief it as a developer message right after the call comes up (it adopts the persona)
  void req("thread/realtime/appendText", { threadId: thread.id, role: "developer", text: opts.brief });
  log("info", `realtime voice up (${opts.voice})`);
  opts.onStatus("listening");

  // --- heard audio up the call: 16 kHz mono in, 48 kHz stereo Opus out, 20 ms RTP packets sent as
  // the audio comes. Lightair sends it only while someone is talking, so in silence nothing goes up
  // the call (the model isn't kept listening to an empty room); the RTP clock follows the wall
  // clock across those gaps.
  const enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  let pending: number[] = []; // 48 kHz mono samples waiting to be sent
  let seq = 0;
  let ts = 0;
  const t0 = performance.now();
  const sendPacket = (mono: number[]) => {
    const stereo = new Int16Array(960 * 2);
    for (let i = 0; i < 960; i++) stereo[i * 2] = stereo[i * 2 + 1] = mono[i]!;
    const payload = enc.encode(Buffer.from(stereo.buffer), 960);
    // after a gap, the timestamp catches up with the time that passed
    const wall = Math.round((performance.now() - t0) * 48);
    if (wall - ts > 4800) ts = wall;
    const h = Buffer.alloc(12);
    h[0] = 0x80;
    h[1] = OPUS_PT;
    h.writeUInt16BE(seq++ & 0xffff, 2);
    h.writeUInt32BE(ts >>> 0, 4);
    h.writeUInt32BE(ssrc, 8);
    ts += 960;
    try {
      track.sendMessageBinary(Buffer.concat([h, payload]));
    } catch {}
  };

  return {
    pushAudio(pcm: Int16Array) {
      // 16 kHz mono → 48 kHz mono (linear ×3)
      for (let i = 0; i < pcm.length; i++) {
        const a = pcm[i]!;
        const b = i + 1 < pcm.length ? pcm[i + 1]! : a;
        pending.push(a, (a * 2 + b) / 3, (a + b * 2) / 3);
      }
      if (!track.isOpen()) {
        pending = pending.slice(-9600);
        return;
      }
      while (pending.length >= 960) sendPacket(pending.splice(0, 960));
    },
    interrupt() {
      pending = [];
    },
    sendText(text: string) {
      void req("thread/realtime/appendText", { threadId: thread.id, text });
    },
    async stop() {
      try {
        await req("thread/realtime/stop", { threadId: thread.id });
      } catch {}
      try {
        pc.close();
      } catch {}
      app.kill();
    },
  };
}
