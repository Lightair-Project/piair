// PiAir: Lightair's AI co-host. Started by Lightair with pipes; see docs/design.md.
import * as brain from "./brain.ts";
import * as director from "./director.ts";
import * as memory from "./memory.ts";
import { log, on, run, send } from "./protocol.ts";
import { voiceKey, warm } from "./secrets.ts";
import * as settings from "./settings.ts";
import { makeVoice } from "./voice/index.ts";

export const VERSION = "0.1.0";

async function applyVoice() {
  const s = settings.get();
  try {
    const key = await voiceKey(s.voice.vendor);
    const v = await makeVoice(s.voice.vendor, key, s.voice.voice, s.voice.speed, s.persona.language);
    director.setVoice(v);
    if (!v && s.voice.vendor !== "none") send({ t: "status", state: "error", detail: `No ${s.voice.vendor} key: PiAir writes instead of speaking` });
  } catch (e) {
    log("warn", "voice:", e);
    director.setVoice(null);
  }
}

on("hello", async (m) => {
  settings.load(m.data_dir ?? ".");
  // the co-host object's own settings (saved with it in the project) win over the last ones used
  const s = m.settings && typeof m.settings === "object" ? settings.update(m.settings) : settings.get();
  memory.open(settings.piairDir(), s.memory.keepDays);
  await warm(brain.models.getProviders().map((p) => p.id));
  await applyVoice();
  send({ t: "ready", version: VERSION, settings: settings.get(), providers: await brain.providerList() });
  log("info", `PiAir ${VERSION} ready (${s.provider}/${s.model}, voice ${s.voice.vendor})`);
});

on("settings", async (m) => {
  const before = settings.get().voice;
  const s = settings.update(m.values ?? {});
  if (JSON.stringify(before) !== JSON.stringify(s.voice) || m.values?.persona?.language) await applyVoice();
  send({ t: "settings", values: s });
});

on("providers", async () => send({ t: "providers", providers: await brain.providerList() }));
on("login", async (m) => {
  try {
    await brain.login(m.provider, m.kind ?? "oauth", m.key);
    if (m.voice_vendor) await applyVoice();
  } catch (e) {
    send({ t: "auth", provider: m.provider, message: e instanceof Error ? e.message : String(e), error: true });
  }
  send({ t: "providers", providers: await brain.providerList() });
});
on("auth_code", (m) => brain.authCode(String(m.code ?? "")));
on("voice_key", async () => applyVoice());

on("chat", (m) => director.onChat(m.event ?? {}));
on("heard", (m) => director.onHeard(String(m.text ?? ""), !!m.final));
on("streamer", (m) => director.onStreamer(!!m.speaking));
on("prompt", (m) => director.onPrompt(String(m.text ?? "")));
on("voice_state", (m) => director.onVoiceState(String(m.utterance ?? ""), String(m.state ?? "")));
on("stop", () => director.stop());
on("computer", (m) => {
  if (m.paused || m.ai_drives === false) brain.stopTask();
});

process.on("unhandledRejection", (e) => log("error", "unhandled:", e as any));
await run(() => {
  log("info", "Lightair closed the channel; bye");
  process.exit(0);
});
