// The streamer's AI apps (codex, claude, agy, grok), started for PiAir.
//
// Installed as a package, PiAir runs in Lightair's sandbox: it can't look in the user's folders
// or start programs. Then Lightair finds, reads and starts these four apps for it, outside the
// sandbox (`cli.which`, `cli.catalog`, `cli.spawn`, `cli.stdin`, `cli.kill`; their output comes
// back as `cli_out` and `cli_exit`). Started any other way (a bundled PiAir, development), PiAir
// does it itself, as before. Either way the caller gets a child with the shape it used from
// node:child_process.

import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { call, on } from "./protocol.ts";

/** Running in Lightair's sandbox (Lightair sets this for package helpers). */
export const bridged = !!process.env.LIGHTAIR_PACKAGE;

/** The folder placeholder Lightair replaces with a fresh scratch folder of its own. */
export const SCRATCH = "{scratch}";

export interface AppChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  /** The names of the app's own settings variables to pass on (CODEX_HOME and the like). */
  configEnv: string[];
  /** Under the bridge: a fresh scratch folder as its working folder (`SCRATCH` in args). */
  scratch?: boolean;
  /** Not bridged: the working folder and environment to use. */
  cwd?: string;
  env?: Record<string, string>;
  /** Ends it after this long. */
  timeoutMs?: number;
}

const bridgedChildren = new Map<number, Bridged>();
/** Output that arrived before its app's id did (Lightair's reply and the app's first output can
 * come in one read, and the reply resolves a tick later). */
const early = new Map<number, { t: string; [k: string]: any }[]>();

class Bridged extends EventEmitter implements AppChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  id = 0;
  private queued: { data: string; end: boolean }[] = [];
  private timer?: Timer;

  constructor(timeoutMs?: number) {
    super();
    this.stdin.on("data", (d: Buffer) => this.write(d.toString("utf8"), false));
    this.stdin.on("finish", () => this.write("", true));
    if (timeoutMs) this.timer = setTimeout(() => this.kill(), timeoutMs);
  }

  started(id: number) {
    this.id = id;
    bridgedChildren.set(id, this);
    for (const m of early.get(id)?.splice(0) ?? []) {
      if (m.t === "cli_out") this.out(m.stream, m.data);
      else this.exited(m.code);
    }
    early.delete(id);
    for (const q of this.queued.splice(0)) void call("cli.stdin", { id, data: q.data, end: q.end }).catch(() => {});
  }

  private write(data: string, end: boolean) {
    if (!this.id) {
      this.queued.push({ data, end });
      return;
    }
    void call("cli.stdin", { id: this.id, data, end }).catch(() => {});
  }

  out(stream: string, data: string) {
    (stream === "stderr" ? this.stderr : this.stdout).write(data);
  }

  exited(code: number | null) {
    if (this.timer) clearTimeout(this.timer);
    this.exitCode = code ?? -1;
    bridgedChildren.delete(this.id);
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code);
    this.emit("close", code);
  }

  kill() {
    if (this.id && this.exitCode === null) void call("cli.kill", { id: this.id }).catch(() => {});
  }
}

function keepEarly(m: { t: string; id: number; [k: string]: any }) {
  const list = early.get(m.id) ?? [];
  if (list.length < 1000) list.push(m);
  early.set(m.id, list);
}
on("cli_out", (m) => {
  const c = bridgedChildren.get(m.id);
  if (c) c.out(m.stream, m.data);
  else keepEarly(m as any);
});
on("cli_exit", (m) => {
  const c = bridgedChildren.get(m.id);
  if (c) c.exited(m.code);
  else keepEarly(m as any);
});

/** Starts one of the four apps. `bin` is what `which` returned. */
export function spawnApp(bin: string, args: string[], opts: SpawnOptions): AppChild {
  if (!bridged) {
    return nodeSpawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], timeout: opts.timeoutMs }) as unknown as AppChild;
  }
  const child = new Bridged(opts.timeoutMs);
  const name = bin.split(/[\\/]/).pop()!.replace(/\.(cmd|exe)$/i, "");
  call<{ id: number }>("cli.spawn", { name, args, config_env: opts.configEnv, scratch: !!opts.scratch }, 15_000)
    .then((r) => child.started(r.id))
    .catch((e) => {
      child.emit("error", e);
      child.exited(null);
    });
  return child;
}

/** Where an app is (its path), or null. Bridged: Lightair looks. */
export async function which(name: string, local: () => Promise<string | null>): Promise<string | null> {
  if (!bridged) return local();
  try {
    return (await call<{ path: string | null }>("cli.which", { name }, 10_000)).path;
  } catch {
    return null;
  }
}

/** An app's model cache file (bridged: read by Lightair; only the files PiAir uses). */
export async function catalogText(name: "claude" | "codex" | "grok", local: () => Promise<string>): Promise<string> {
  if (!bridged) return local();
  const r = await call<{ text: string | null }>("cli.catalog", { name }, 10_000);
  if (r.text == null) throw new Error("no catalog");
  return r.text;
}
