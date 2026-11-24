// Which models each provider offers now. Pi's catalog is fixed when pi-ai is released, so it has
// models a provider has since retired and lacks ones it has added. Where Lightair has a key or a
// sign-in for a provider (OpenRouter's list is public), the provider's own model list decides:
// models it no longer lists are left out, new ones are added (made from the closest model Pi knows,
// so they're called the same way), newest first. Without a list, Pi's catalog is shown newest
// first, without dated snapshots.
import type { Model } from "@earendil-works/pi-ai";
import { log } from "./protocol.ts";

type Live = { id: string; name?: string; created?: number; images?: boolean; context?: number };
type Models = {
  getModels(provider: string): readonly Model<any>[];
  getAuth(provider: string): Promise<{ auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string } } | undefined>;
};

const lists = new Map<string, Live[]>();
const fetchedAt = new Map<string, number>();
const TTL = 30 * 60_000;

/** Not a chat model: speech, images, embeddings, moderation and the like. */
const NOT_CHAT = /(embed|moderation|whisper|tts|transcri|audio|realtime|image|dall-e|sora|search-preview|instruct|davinci|babbage|computer-use|robotics|deep-research|guard)/i;
/** A dated snapshot of a model that's also listed under its own name. */
const SNAPSHOT = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{4})$/;

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`${url.split("?")[0]} answered ${r.status}`);
  return r.json();
}

/** The provider's own list of its models now, or null when it can't be had. */
async function fetchLive(provider: string, models: Models): Promise<Live[] | null> {
  if (provider === "openrouter") {
    const j = await getJson("https://openrouter.ai/api/v1/models", {});
    const today = new Date().toISOString().slice(0, 10);
    return (j.data ?? [])
      .filter((m: any) => !m.expiration_date || m.expiration_date > today)
      .map((m: any) => ({
        id: m.id,
        name: m.name,
        created: m.created,
        images: (m.architecture?.input_modalities ?? []).includes("image"),
        context: m.context_length ?? undefined,
      }));
  }
  const a = await models.getAuth(provider).catch(() => undefined);
  const key = a?.auth.apiKey;
  if (!key) return null;
  const bearer = { Authorization: `Bearer ${key}`, ...(a?.auth.headers ?? {}) };
  const openaiLike = async (base: string) => {
    const j = await getJson(`${base}/models`, bearer);
    return (j.data ?? []).map((m: any) => ({ id: m.id, created: m.created }));
  };
  switch (provider) {
    case "openai":
      return openaiLike(a?.auth.baseUrl ?? "https://api.openai.com/v1");
    case "groq":
      return openaiLike("https://api.groq.com/openai/v1");
    case "xai":
      return openaiLike("https://api.x.ai/v1");
    case "cerebras":
      return openaiLike("https://api.cerebras.ai/v1");
    case "anthropic": {
      // a Claude subscription's token, or an API key
      const oauth = key.startsWith("sk-ant-oat");
      const headers: Record<string, string> = oauth
        ? { Authorization: `Bearer ${key}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" }
        : { "x-api-key": key, "anthropic-version": "2023-06-01" };
      const j = await getJson("https://api.anthropic.com/v1/models?limit=1000", headers);
      return (j.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name, created: m.created_at ? Date.parse(m.created_at) / 1000 : undefined }));
    }
    case "google": {
      const j = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`, {});
      return (j.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => ({ id: String(m.name).replace(/^models\//, ""), name: m.displayName }));
    }
    default:
      return null;
  }
}

/** Fetches the lists of providers that have one and are due, in parallel. True when one changed. */
export async function refresh(models: Models, providers: string[]): Promise<boolean> {
  let changed = false;
  await Promise.all(
    providers.map(async (p) => {
      if (Date.now() - (fetchedAt.get(p) ?? 0) < TTL) return;
      try {
        const live = await fetchLive(p, models);
        fetchedAt.set(p, Date.now());
        if (live?.length) {
          lists.set(p, live);
          changed = true;
        }
      } catch (e) {
        log("warn", `models of ${p}:`, e);
      }
    }),
  );
  return changed;
}

/** Forgets the lists (a key or sign-in changed): the next refresh asks again. */
export function forget() {
  fetchedAt.clear();
  lists.clear();
}

/** A rough version for ordering by name: "gpt-6.2-sol" → 6.2, "claude-opus-5-5" → 5.5; numbers
 * that look like dates or sizes ("2603", "120b") don't count. */
function version(id: string): number {
  const name = id.replace(/^[^/]*\//, "");
  for (const m of name.matchAll(/(?<![\d.])(\d{1,2})(?:[.-](\d{1,2}))?(?![\d]|b\b)/g)) {
    return Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
  }
  return 0;
}

/** Offered at all: a model that talks (not one for speech, images or long research), not a batch
 * duplicate. */
function offered(id: string): boolean {
  return !NOT_CHAT.test(id) && !id.endsWith(":batch");
}

/** The catalog model a new model is made from: the one sharing the longest start of its id. */
function template(catalog: readonly Model<any>[], id: string): Model<any> | undefined {
  let best: Model<any> | undefined;
  let bestLen = -1;
  for (const m of catalog) {
    let n = 0;
    while (n < m.id.length && n < id.length && m.id[n] === id[n]) n++;
    if (n > bestLen) {
      best = m;
      bestLen = n;
    }
  }
  return best;
}

/** A provider's models as they should be offered, newest first. */
export function current(models: Models, provider: string): Model<any>[] {
  const catalog = models.getModels(provider);
  const live = lists.get(provider);
  if (!live) {
    return catalog
      .filter((m) => !SNAPSHOT.test(m.id) && offered(m.id))
      .slice()
      .sort((a, b) => version(b.id) - version(a.id) || a.id.localeCompare(b.id));
  }
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const out: { m: Model<any>; created: number }[] = [];
  for (const l of live) {
    if (!offered(l.id)) continue;
    let m = byId.get(l.id);
    if (!m) {
      // a model Pi doesn't know yet, made from the closest one it does
      const t = template(catalog, l.id);
      if (!t) continue;
      m = {
        ...t,
        id: l.id,
        name: l.name ?? l.id,
        input: l.images === undefined ? t.input : l.images ? ["text", "image"] : ["text"],
        ...(l.context ? { contextWindow: l.context } : {}),
      } as Model<any>;
    }
    if (SNAPSHOT.test(m.id) && live.some((o) => o.id === m!.id.replace(SNAPSHOT, ""))) continue;
    out.push({ m, created: l.created ?? 0 });
  }
  out.sort((a, b) => b.created - a.created || version(b.m.id) - version(a.m.id) || a.m.id.localeCompare(b.m.id));
  return out.map((o) => o.m);
}

/** A model by id, Pi's or one made from a provider's list. */
export function find(models: Models, provider: string, id: string): Model<any> | undefined {
  return current(models, provider).find((m) => m.id === id) ?? models.getModels(provider).find((m) => m.id === id);
}
