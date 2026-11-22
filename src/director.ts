// The director: decides when the co-host speaks and what to. Chat is scored and batched, the
// streamer always comes first, and PiAir never talks over the streamer.
import * as brain from "./brain.ts";
import * as memory from "./memory.ts";
import { log, send } from "./protocol.ts";
import * as settings from "./settings.ts";
import { moderate, speakable, Splitter } from "./speech.ts";
import { turnViewers } from "./tools/talk.ts";
import type { Source } from "./tools/types.ts";
import type { Voice } from "./voice/index.ts";

type Candidate = { score: number; at: number; line: string; who: string; platform: string; viewer: string; urgent: boolean };

/** Least time between turns PiAir starts on its own, by chattiness. Infinity: only when addressed. */
const GAP_MS = [Infinity, 45_000, 20_000, 8_000];

let voice: Voice | null = null;
let candidates: Candidate[] = [];
let busy = false;
let current: AbortController | null = null;
let currentUtterance: { cancel(): void; id: string } | null = null;
let speaking = new Set<string>();
let streamerSpeaking = false;
let streamerStoppedAt = 0;
let streamerTalkingSince = 0;
let lastTurnAt = 0;
let lastSpokeEndedAt = 0;
let uttSeq = 0;
const seenViewers = new Set<string>();
const recentTexts: string[] = [];
let queuedTrusted: { source: Source; prompt: string } | null = null;

export function setVoice(v: Voice | null) {
  voice?.close();
  voice = v;
  void voice?.warm();
}

const esc = (s: string) => s.replace(/</g, "‹").replace(/>/g, "›").slice(0, 400);
const nameRe = () => new RegExp(`\\b${settings.get().persona.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

// ------------------------------------------------------------------ inputs

export function onChat(ev: any) {
  const kind = ev.kind ?? "message";
  const user = ev.user ?? {};
  const who = String(user.display_name ?? user.login ?? "someone");
  const platform = String(ev.platform ?? "");
  const viewer = String(user.id ?? who);
  const textIn = String(ev.text ?? "").trim();
  if (ev.deleted || kind === "deletion") return;
  if (textIn) memory.record("viewer", textIn, who, platform, viewer);
  if (!settings.get().behaviour.answerChat && kind === "message") return;

  const key = `${platform}:${viewer}`;
  const first = !seenViewers.has(key);
  seenViewers.add(key);
  let score = 1;
  let urgent = false;
  if (nameRe().test(textIn)) score *= 3;
  if (/\?\s*$/.test(textIn)) score *= 2;
  if (first) score *= 1.5;
  if ((user.roles ?? []).some((r: any) => /mod|broadcaster|vip/i.test(String(r)))) score *= 1.2;
  if (kind === "paid" || kind === "membership" || kind === "raid") {
    score *= 4;
    urgent = true;
  }
  if (recentTexts.includes(textIn.toLowerCase()) || textIn.length < 2 || /^!/.test(textIn)) score = 0;
  recentTexts.push(textIn.toLowerCase());
  if (recentTexts.length > 50) recentTexts.shift();
  if (score <= 0 && !urgent) return;

  const what = kind === "message" ? "" : ` (${kind}${ev.paid?.amount ? ` ${ev.paid.amount} ${ev.paid.currency ?? ""}` : ""}${ev.headline ? `: ${ev.headline}` : ""})`;
  const tags = [platform, first ? "first message" : ""].filter(Boolean).join(", ");
  candidates.push({ score, at: Date.now(), line: `[${tags}] ${esc(who)}${what}: ${esc(textIn)}`, who, platform, viewer, urgent });
  if (candidates.length > 60) candidates = candidates.sort((a, b) => b.score - a.score).slice(0, 40);
}

export function onHeard(text: string, final: boolean) {
  if (!final || !text.trim()) return;
  memory.record("streamer", text);
  send({ t: "transcript", role: "streamer", text });
  if (!settings.get().behaviour.listen) return;
  const addressed = nameRe().test(text) || (Date.now() - lastSpokeEndedAt < 8_000 && /\?\s*$/.test(text));
  if (addressed) startTrusted("streamer", `The streamer said to you: ${text}`);
}

export function onPrompt(text: string) {
  send({ t: "transcript", role: "streamer", text });
  memory.record("streamer", text);
  startTrusted("streamer", `The streamer (typing to you in Lightair's PiAir panel): ${text}`);
}

export function onStreamer(isSpeaking: boolean) {
  const now = Date.now();
  if (isSpeaking && !streamerSpeaking) streamerTalkingSince = now;
  if (!isSpeaking && streamerSpeaking) streamerStoppedAt = now;
  streamerSpeaking = isSpeaking;
}

export function onVoiceState(utterance: string, state: string) {
  if (state === "playing") speaking.add(utterance);
  else {
    if (speaking.delete(utterance) && speaking.size === 0) lastSpokeEndedAt = Date.now();
  }
  status();
}

/** The kill switch, or the panel's stop. */
export function stop() {
  queuedTrusted = null;
  candidates = [];
  current?.abort();
  brain.stopTask();
  currentUtterance?.cancel();
  send({ t: "voice_cancel" });
  speaking.clear();
  status();
}

function startTrusted(source: Source, prompt: string) {
  // the streamer interrupts PiAir's own talk
  if (busy || speaking.size) {
    queuedTrusted = { source, prompt };
    current?.abort();
    currentUtterance?.cancel();
    send({ t: "voice_cancel" });
    speaking.clear();
    return;
  }
  void turn(source, prompt);
}

// ------------------------------------------------------------------ the loop

function status(detail?: string) {
  const state = busy ? (speaking.size ? "speaking" : "thinking") : speaking.size ? "speaking" : "listening";
  send({ t: "status", state, ...(detail ? { detail } : {}) });
}

setInterval(() => {
  const now = Date.now();
  // the streamer talks over PiAir: stop after a moment (not for a cough)
  if (streamerSpeaking && speaking.size && settings.get().behaviour.stopWhenStreamerTalks && now - streamerTalkingSince > 600) {
    currentUtterance?.cancel();
    send({ t: "voice_cancel" });
    speaking.clear();
  }
  if (busy || speaking.size) return;
  if (queuedTrusted) {
    const q = queuedTrusted;
    queuedTrusted = null;
    void turn(q.source, q.prompt);
    return;
  }
  if (streamerSpeaking || now - streamerStoppedAt < 700) return;
  // old chat goes stale
  candidates = candidates.filter((c) => now - c.at < 90_000);
  if (!candidates.length) return;
  const chattiness = settings.get().behaviour.chattiness;
  const addressed = candidates.some((c) => c.urgent || c.score >= 3);
  const gap = addressed ? Math.min(GAP_MS[chattiness]!, 4_000) : GAP_MS[chattiness]!;
  if (now - lastTurnAt < gap) return;
  const pick = candidates.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, 5).sort((a, b) => a.at - b.at);
  candidates = candidates.filter((c) => !pick.includes(c));
  turnViewers.clear();
  const notes: string[] = [];
  for (const c of pick) {
    turnViewers.set(c.who, { platform: c.platform, id: c.viewer });
    const n = memory.readNote("viewer", { platform: c.platform, id: c.viewer });
    if (n) notes.push(`${c.who}: ${n.trim()}`);
  }
  const prompt = [
    `Recent chat (answer one or two of these if worth it, or [skip]):`,
    `<chat untrusted="true">`,
    ...pick.map((c) => c.line),
    `</chat>`,
    notes.length ? `What you remember about them:\n${notes.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  void turn(pick.some((c) => c.urgent) ? "event" : "chat", prompt);
}, 250);

async function turn(source: Source, prompt: string) {
  busy = true;
  lastTurnAt = Date.now();
  const ac = new AbortController();
  current = ac;
  status();
  const s = settings.get();
  const id = `u${++uttSeq}`;
  const utt = voice?.utterance(id) ?? null;
  currentUtterance = utt ? { id, cancel: () => utt.cancel() } : null;
  let said = "";
  let head = "";
  let skipped = false;
  let cut = false;
  const t0 = performance.now();
  let firstPieceMs = 0;
  const splitter = new Splitter((piece) => {
    if (cut || ac.signal.aborted) return;
    // a mood tag at the start of a sentence changes the face, isn't said
    const tag = /^\s*\[(happy|surprised|thinking|sad|angry|neutral)\]\s*/i.exec(piece);
    if (tag) send({ t: "face", mood: tag[1]!.toLowerCase() });
    const line = speakable(piece.replace(/\[(happy|surprised|thinking|sad|angry|neutral)\]\s*/gi, ""));
    if (!line) return;
    const v = moderate(line, s.persona.familyFriendly);
    if (!v.ok) {
      log("warn", `moderation dropped a sentence (${v.reason})`);
      cut = true;
      return;
    }
    if (!firstPieceMs) firstPieceMs = Math.round(performance.now() - t0);
    said += (said ? " " : "") + line;
    utt?.say(line);
  });
  try {
    await brain.cohostTurn(source, prompt, {
      onText(delta) {
        if (skipped || cut) return;
        if (head.length < 8) {
          head += delta;
          if (/^\s*\[skip/i.test(head)) {
            skipped = true;
            return;
          }
          if (head.length < 8 && !/[.!?]/.test(head)) return;
          splitter.push(head);
          return;
        }
        splitter.push(delta);
      },
      onToolStart() {
        // a tool call in the middle: say what came before it now
        if (head && head.length < 8 && !skipped) {
          splitter.push(head);
          head = "        ";
        }
        splitter.end();
      },
    }, ac.signal);
    if (!skipped && head.length < 8 && head.trim()) splitter.push(head);
    splitter.end();
  } catch (e) {
    log("warn", "turn:", e);
    send({ t: "status", state: "error", detail: e instanceof Error ? e.message : String(e) });
  } finally {
    utt?.end();
    if (said) {
      send({ t: "transcript", role: "piair", text: said });
      memory.record("piair", said);
      log("info", `turn ${id}: first sentence ${firstPieceMs} ms${utt ? "" : " (no voice)"}`);
    }
    if (utt) {
      void utt.finished.then(() => {
        if (utt.firstAudioMs !== undefined) log("info", `turn ${id}: voice first audio ${utt.firstAudioMs} ms after the first sentence`);
      });
    }
    busy = false;
    current = null;
    status();
  }
}
