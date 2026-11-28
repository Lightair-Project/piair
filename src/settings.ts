// PiAir's settings: a JSON file under Lightair's data folder (no secrets in it).
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export type VoiceVendor = "cartesia" | "elevenlabs" | "gemini" | "system" | "none";

export interface Settings {
  provider: string;
  model: string;
  voice: { vendor: VoiceVendor; voice: string; speed: number };
  persona: { name: string; personality: string; language: string; familyFriendly: boolean };
  behaviour: { chattiness: 0 | 1 | 2 | 3; answerChat: boolean; stopWhenStreamerTalks: boolean; listen: boolean; strictModeration: boolean };
  memory: { keepDays: number };
}

export const DEFAULTS: Settings = {
  provider: "google",
  model: "gemini-flash-lite-latest",
  voice: { vendor: "gemini", voice: "", speed: 1 },
  persona: {
    name: "Pi",
    personality: "Warm, quick and playful. Teases a little, never mean. Keeps it short.",
    language: "English",
    familyFriendly: true,
  },
  behaviour: { chattiness: 1, answerChat: true, stopWhenStreamerTalks: true, listen: true, strictModeration: false },
  memory: { keepDays: 90 },
};

/** Default voice per vendor (each vendor's own stock voice ids). */
export const DEFAULT_VOICES: Record<VoiceVendor, string> = {
  cartesia: "", // the first stock voice the account lists (Lightair picks it)
  elevenlabs: "", // chosen in the co-host's Voice section (the account's voices)
  gemini: "Puck",
  system: "", // the computer's default voice
  none: "",
};

let dir = "";
let current: Settings = structuredClone(DEFAULTS);
const listeners: ((s: Settings) => void)[] = [];

function merge<T>(base: T, over: any): T {
  if (over === null || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = typeof (base as any)?.[k] === "object" && !Array.isArray((base as any)[k]) ? merge((base as any)[k], v) : v;
  }
  return out;
}

/** A voice from a vendor PiAir no longer has (the ChatGPT realtime voice, "codex", was dropped in
 * 0.2.2) becomes the computer's own voice. */
function known(s: Settings): Settings {
  if (!(s.voice.vendor in DEFAULT_VOICES)) s.voice = { ...s.voice, vendor: "system", voice: "" };
  return s;
}

export function load(dataDir: string) {
  dir = join(dataDir, "PiAir");
  mkdirSync(dir, { recursive: true });
  try {
    current = known(merge(DEFAULTS, JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))));
  } catch {
    current = structuredClone(DEFAULTS);
  }
  return current;
}

export function piairDir() {
  return dir;
}

export function get(): Settings {
  return current;
}

export function update(values: Partial<Settings> | Record<string, unknown>) {
  current = known(merge(current, values));
  if (dir) {
    const tmp = join(dir, "settings.json.tmp");
    writeFileSync(tmp, JSON.stringify(current, null, 2));
    renameSync(tmp, join(dir, "settings.json"));
  }
  for (const l of listeners) l(current);
  return current;
}

export function onChange(l: (s: Settings) => void) {
  listeners.push(l);
}
