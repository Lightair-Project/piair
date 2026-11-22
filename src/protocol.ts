// The channel to Lightair: newline-delimited JSON on stdin (from Lightair) and stdout (to it).
// stdout carries only protocol lines; the log goes to stderr. PiAir exits when stdin closes.

export type Message = { t: string; [k: string]: any };
type Handler = (m: Message) => void | Promise<void>;

const handlers = new Map<string, Handler[]>();
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer }>();
let nextId = 1;
let closed = false;

export class CallError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function log(level: "info" | "warn" | "error", ...parts: unknown[]) {
  const text = parts.map((p) => (typeof p === "string" ? p : p instanceof Error ? p.message : JSON.stringify(p))).join(" ");
  process.stderr.write(`${new Date().toISOString()} ${level} ${text}\n`);
}

export function send(m: Message) {
  if (closed) return;
  process.stdout.write(JSON.stringify(m) + "\n");
}

export function on(t: string, h: Handler) {
  const list = handlers.get(t) ?? [];
  list.push(h);
  handlers.set(t, list);
}

/** A Lightair method (the remote API's or PiAir's own); rejects with `CallError`. */
export function call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new CallError("timeout", `${method} took longer than ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ t: "call", id, method, params });
  });
}

function dispatch(m: Message) {
  if (m.t === "reply") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new CallError(m.error.code ?? "error", m.error.message ?? String(m.error)));
    else p.resolve(m.result);
    return;
  }
  for (const h of handlers.get(m.t) ?? []) {
    Promise.resolve(h(m)).catch((e) => log("error", `handling ${m.t}:`, e));
  }
}

/** Reads stdin until it closes, then calls `onClose`. */
export async function run(onClose: () => void) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let k: number;
    while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k).trim();
      buf = buf.slice(k + 1);
      if (!line) continue;
      try {
        dispatch(JSON.parse(line));
      } catch (e) {
        log("warn", "bad line from Lightair:", e);
      }
    }
  }
  closed = true;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new CallError("closed", "Lightair closed the channel"));
  }
  onClose();
}
