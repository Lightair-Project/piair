// Secrets live in Lightair's Keychain (Credential Manager on Windows), asked for over the channel.
// A Pi `CredentialStore` on top, so Pi's API-key and OAuth (subscription) auth both persist there.
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { call, log } from "./protocol.ts";

const cache = new Map<string, string | null>();

/** Lightair changed keys (Settings → Connections): read them again next time. */
export function forget() {
  cache.clear();
}

export async function getSecret(name: string): Promise<string | undefined> {
  if (cache.has(name)) return cache.get(name) ?? undefined;
  try {
    const r = await call<{ value?: string | null }>("secret.get", { name }, 10_000);
    cache.set(name, r?.value ?? null);
    return r?.value ?? undefined;
  } catch (e) {
    log("warn", `secret ${name}:`, e);
    return undefined;
  }
}

export async function setSecret(name: string, value: string | null) {
  cache.set(name, value);
  await call("secret.set", { name, value }, 10_000);
}

const locks = new Map<string, Promise<unknown>>();
const known = new Set<string>();

export const store: CredentialStore = {
  async read(providerId) {
    const raw = await getSecret(`provider:${providerId}`);
    if (!raw) return undefined;
    try {
      known.add(providerId);
      return JSON.parse(raw) as Credential;
    } catch {
      return undefined;
    }
  },
  async list() {
    const out: CredentialInfo[] = [];
    for (const id of known) {
      const c = await this.read(id);
      if (c) out.push({ providerId: id, type: c.type });
    }
    return out;
  },
  async modify(providerId, fn) {
    const prev = locks.get(providerId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const cur = await store.read(providerId);
      const updated = await fn(cur);
      if (updated) {
        await setSecret(`provider:${providerId}`, JSON.stringify(updated));
        known.add(providerId);
        return updated;
      }
      return cur;
    });
    locks.set(providerId, next.catch(() => {}));
    return next;
  },
  async delete(providerId) {
    await setSecret(`provider:${providerId}`, null);
    known.delete(providerId);
  },
};

/** Which providers have something stored (asked for at start so `list()` knows them). */
export async function warm(providerIds: string[]) {
  await Promise.all(providerIds.map((id) => store.read(id)));
}
