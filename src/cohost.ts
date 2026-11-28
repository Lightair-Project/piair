// PiAir, the co-host: started by Lightair with pipes; see docs/design.md.
import * as brain from "./brain.ts";
import * as director from "./director.ts";
import * as memory from "./memory.ts";
import { log, on, run, send } from "./protocol.ts";
import { forget, warm } from "./secrets.ts";
import * as settings from "./settings.ts";
import * as streamer from "./streamer.ts";
import { LightairVoice } from "./voice.ts";

export const VERSION = "0.3.0";

async function applyVoice() {
  const s = settings.get();
  // Lightair speaks the text it's sent (its built-in voices; keys stay in Lightair)
  director.setVoice(s.voice.vendor === "none" ? null : new LightairVoice());
}

on("hello", async (m) => {
  settings.load(m.data_dir ?? ".");
  // the co-host object's own settings (saved with it in the project) win over the last ones used
  const s = m.settings && typeof m.settings === "object" ? settings.update(m.settings) : settings.get();
  memory.open(settings.piairDir(), s.memory.keepDays);
  await warm(brain.models.getProviders().map((p) => p.id));
  await applyVoice();
  send({ t: "ready", version: VERSION, settings: settings.get(), providers: await brain.providerList() });
  // the providers' current model lists, after: the panel's list is replaced when they come
  void brain.refreshCatalog().then(async (changed) => changed && send({ t: "providers", providers: await brain.providerList() }));
  // the streamer's AI apps on this computer
  void brain.refreshClis().then(async (changed) => changed && send({ t: "providers", providers: await brain.providerList() }));
  log("info", `PiAir ${VERSION} ready (${s.provider}/${s.model}, voice ${s.voice.vendor})`);
  // AI streamer mode as Lightair has it (asks for its permissions when it's on)
  if (m.mode && typeof m.mode === "object") void streamer.setMode(String(m.mode.mode ?? "off"), m.mode.policy);
});

// AI streamer mode switched in Lightair (Settings › AI co-host)
on("mode", async (m) => {
  await streamer.setMode(String(m.mode ?? "off"), m.policy);
  brain.resetCohost();
});

on("settings", async (m) => {
  const before = settings.get().voice;
  const s = settings.update(m.values ?? {});
  if (JSON.stringify(before) !== JSON.stringify(s.voice) || m.values?.persona?.language) await applyVoice();
  send({ t: "settings", values: s });
});

on("providers", async () => {
  await brain.refreshClis();
  send({ t: "providers", providers: await brain.providerList() });
});
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
// keys added or removed in Settings → Connections: read again, voice reconnected
on("secrets_changed", async () => {
  forget();
  await warm(brain.models.getProviders().map((p) => p.id));
  await applyVoice();
  send({ t: "providers", providers: await brain.providerList() });
  if (await brain.refreshCatalog(true)) send({ t: "providers", providers: await brain.providerList() });
});

on("chat", (m) => director.onChat(m.event ?? {}));
// `streamer`: Lightair says this line came from the streamer's own track (only those are trusted)
on("heard", (m) => director.onHeard(String(m.text ?? ""), !!m.final, m.who ? String(m.who) : undefined, m.streamer === true));
on("content", (m) => director.onContent(String(m.text ?? ""), String(m.source ?? "")));
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
