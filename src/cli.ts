// The streamer's own AI command-line apps as the co-host's brain: their plans the supported way.
// Each turn runs the app once, in its print mode, in an empty scratch folder, with a scrubbed
// environment and none of its tools (it only answers in text; PiAir speaks it). Checked against
// live runs of each app.
//
//   codex   ChatGPT plan        codex exec --json                       ~15k tokens of setup a call
//   claude  Claude plan         claude -p --output-format stream-json    ~750 (our system prompt, no tools)
//   agy     Google AI plan      agy -p … --output-format stream-json     ~12k (it's an agent)
//   grok    SuperGrok / X plan  grok -p … --output-format streaming-messages-json   ~7k
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

export type CliName = "codex" | "claude" | "agy" | "grok";
export type CliModel = { id: string; name: string };

export interface CliStatus {
  name: CliName;
  installed: boolean;
  signedIn: boolean;
  version?: string;
  models: CliModel[];
  /** How to sign in when it isn't */
  login: string;
}

interface Spec {
  bin: CliName;
  label: string;
  configEnv: string[];
  login: string;
  knownModels: string[];
  systemFlag: boolean;
  promptInArgs?: boolean;
  modelsCommand?: string[];
  catalog?: () => Promise<CliModel[] | null>;
  modelLines?: (stdout: string) => CliModel[];
  args(model: string, system: string, prompt: string, dir: string): string[];
  parse(line: string, s: ParseState): string[];
}

interface ParseState {
  streamed: boolean;
  sawText: boolean;
  done: boolean;
  messages: string[];
  error?: string;
  lastError?: string;
}

const newState = (): ParseState => ({ streamed: false, sawText: false, done: false, messages: [] });

const BASIC_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "SHELL", "TMPDIR"];
const WINDOWS_ENV = ["SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"];

/** Only the basics and the app's own config folder: no keys of ours or the streamer's. */
function scrubbedEnv(configEnv: string[]): Record<string, string> {
  const keep = [...BASIC_ENV, ...configEnv, ...(process.platform === "win32" ? WINDOWS_ENV : [])];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  // an app started from the Dock has a short PATH: the usual install folders too
  env.PATH = [...new Set([...(env.PATH ?? "").split(delimiter), ...searchDirs()])].filter(Boolean).join(delimiter);
  env.NO_COLOR = "1";
  return env;
}

function json(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const modelArg = (m: string) => (m && m !== "default" ? m : undefined);

// Keeps an agent app from treating a request as a job to do with its tools
const DIRECT = "Answer directly in your reply. Do not use tools, do not create files, and do not describe what you did: the reply itself is what you say.";

// ---- Codex: `codex exec --json` JSONL; only the turn's last agent message is the answer
function parseCodex(line: string, s: ParseState): string[] {
  const ev = json(line);
  if (!ev) return [];
  switch (ev.type) {
    case "item.completed": {
      const item = ev.item ?? {};
      const kind = item.type ?? item.item_type;
      if ((kind === "agent_message" || kind === "assistant_message") && typeof item.text === "string") s.messages.push(item.text);
      return [];
    }
    case "turn.completed": {
      const answer = s.messages.at(-1) ?? "";
      s.done = true;
      s.sawText = !!answer;
      return answer ? [answer] : [];
    }
    case "turn.failed":
      s.error = `Codex: ${String(ev.error?.message ?? "failed")}`;
      return [];
    case "error":
      s.lastError = String(ev.message ?? "");
      return [];
    default:
      return [];
  }
}

// ---- Claude Code (and Grok, which speaks the same): stream-json with partial deltas
function parseClaude(line: string, s: ParseState): string[] {
  const ev = json(line);
  if (!ev) return [];
  if (ev.type === "stream_event") {
    const e = ev.event ?? {};
    if (e.type === "message_start") s.streamed = false;
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
      s.streamed = true;
      s.sawText = true;
      return [e.delta.text];
    }
    return [];
  }
  if (ev.type === "assistant") {
    if (s.streamed) return [];
    const text = ((ev.message?.content ?? []) as { type: string; text?: string }[])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
    if (!text) return [];
    s.sawText = true;
    return [text];
  }
  if (ev.type === "result") {
    if (ev.is_error || (ev.subtype && ev.subtype !== "success")) {
      s.error = String(ev.result ?? ev.error ?? ev.subtype ?? "failed");
      return [];
    }
    s.done = true;
    if (!s.sawText && typeof ev.result === "string" && ev.result) return [ev.result];
  }
  return [];
}

// ---- Antigravity: step_update deltas, then a result
function parseAntigravity(line: string, s: ParseState): string[] {
  const ev = json(line);
  if (!ev) return [];
  if (ev.event === "step_update") {
    const u = ev.step_update ?? {};
    if (u.step_type !== "agent_response" || typeof u.text_delta !== "string" || !u.text_delta) return [];
    s.sawText = true;
    return [u.text_delta];
  }
  if (ev.event === "result") {
    const r = ev.result ?? {};
    if (r.status && r.status !== "SUCCESS") {
      s.error = `Antigravity: ${String(r.error?.message ?? r.error ?? r.response ?? r.status)}`;
      return [];
    }
    s.done = true;
    if (!s.sawText && typeof r.response === "string" && r.response) return [r.response];
  }
  return [];
}

// ---- The apps' own model catalogs (what this account's plan offers)

async function newestFile(dir: string, suffix: string): Promise<string | null> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(suffix));
  if (!files.length) return null;
  const dated = await Promise.all(files.map(async (f) => ({ f, at: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })));
  return join(dir, dated.sort((a, b) => b.at - a.at)[0]!.f);
}

async function claudeCatalog(): Promise<CliModel[] | null> {
  const file = await newestFile(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "cache", "model-catalog"), "-cc.json");
  if (!file) return null;
  const models = JSON.parse(await readFile(file, "utf8"))?.catalog?.config?.models;
  if (!Array.isArray(models)) return null;
  const out = models.filter((m: any) => m?.id && !m.hidden).map((m: any) => ({ id: m.id, name: m.name || m.id }));
  return out.length ? out : null;
}

async function codexCatalog(): Promise<CliModel[] | null> {
  const d = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json"), "utf8"));
  const models = d?.models;
  if (!Array.isArray(models)) return null;
  const out = models.filter((m: any) => m?.slug && (!m.visibility || m.visibility === "list")).map((m: any) => ({ id: m.slug, name: m.display_name || m.slug }));
  return out.length ? out : null;
}

async function grokCatalog(): Promise<CliModel[] | null> {
  const d = JSON.parse(await readFile(join(process.env.GROK_HOME || join(homedir(), ".grok"), "models_cache.json"), "utf8"));
  const raw = d?.models;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  const out = (list as any[]).map((x) => x?.info ?? x).filter((m: any) => m?.id && !m.hidden).map((m: any) => ({ id: m.id, name: m.name || m.id }));
  return out.length ? out : null;
}

/** `agy models`: "<id>\t<label>" lines; one model per effort ("-low", "-medium", "-high") kept once, at medium. */
function agyModels(stdout: string): CliModel[] {
  const all = stdout
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 2 && p[0]!.trim())
    .map(([id, label]) => ({ id: id!.trim(), name: label!.trim() }));
  return all.filter((m) => !/-(low|high|xhigh|max)$/.test(m.id)).map((m) => ({ ...m, name: m.name.replace(/\s*\((medium)\)\s*$/i, "") }));
}

/** `grok models`: "  * grok-4.7 (default)" lines, only when signed in. */
function grokModels(stdout: string): CliModel[] {
  if (!/logged in/i.test(stdout)) return [];
  return [...stdout.matchAll(/^\s*[*-]\s+(\S+)(?:\s+\((default)\))?/gm)].map((m) => ({ id: m[1]!, name: m[1]! }));
}

// Grok's built-in tools, all removed (unknown names are ignored by grok)
const GROK_TOOLS =
  "read_file,search_replace,list_dir,grep,todo_write,scheduler_create,scheduler_delete,scheduler_list,monitor,search_tool,use_tool,workflow,enter_plan_mode,exit_plan_mode,ask_user_question,send_feedback,image_gen,image_edit,image_to_video,reference_to_video,write,run_terminal_command,kill_command_or_subagent,get_command_or_subagent_output,spawn_subagent";

export const SPECS: Record<CliName, Spec> = {
  claude: {
    bin: "claude",
    label: "Claude Code",
    // ANTHROPIC_API_KEY is deliberately not passed: this is for the streamer's plan
    configEnv: ["CLAUDE_CONFIG_DIR"],
    login: "claude auth login",
    knownModels: ["default", "sonnet", "opus", "haiku"],
    systemFlag: true,
    catalog: claudeCatalog,
    args: (model, system) => {
      const m = modelArg(model);
      return ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", ...(system ? ["--system-prompt", system] : []), ...(m ? ["--model", m] : [])];
    },
    parse: parseClaude,
  },
  codex: {
    bin: "codex",
    label: "Codex",
    configEnv: ["CODEX_HOME"],
    login: "codex login",
    knownModels: ["default"],
    systemFlag: false,
    catalog: codexCatalog,
    args: (model, _system, _prompt, dir) => {
      const m = modelArg(model);
      return ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-C", dir, ...(m ? ["-m", m] : []), "-"];
    },
    parse: parseCodex,
  },
  agy: {
    bin: "agy",
    label: "Antigravity",
    // GEMINI_API_KEY is deliberately not passed
    configEnv: [],
    login: "agy",
    knownModels: ["default"],
    systemFlag: false,
    promptInArgs: true,
    modelsCommand: ["models"],
    modelLines: agyModels,
    args: (model, _system, prompt) => {
      const m = modelArg(model);
      return ["-p", `${DIRECT}\n\n${prompt}`, "--output-format", "stream-json", "--sandbox", "--disable-slash-commands", ...(m ? ["--model", m] : [])];
    },
    parse: parseAntigravity,
  },
  grok: {
    bin: "grok",
    label: "Grok",
    configEnv: [],
    login: "grok login",
    knownModels: ["default"],
    systemFlag: true,
    promptInArgs: true,
    modelsCommand: ["models"],
    modelLines: grokModels,
    catalog: grokCatalog,
    args: (model, system, prompt) => {
      const m = modelArg(model);
      return [
        "-p",
        `${DIRECT}\n\n${prompt}`,
        "--output-format",
        "streaming-messages-json",
        "--include-partial-messages",
        ...(system ? ["--system-prompt-override", system] : []),
        "--disallowed-tools",
        GROK_TOOLS,
        "--no-subagents",
        "--disable-web-search",
        "--max-turns",
        "1",
        "--verbatim",
        ...(m ? ["--model", m] : []),
      ];
    },
    parse: parseClaude,
  },
};

/** Where the apps install (an app started from the Dock has a short PATH). */
function searchDirs(): string[] {
  const home = homedir();
  return [join(home, ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin", join(home, ".npm-global", "bin"), join(home, ".bun", "bin"), join(home, ".volta", "bin"), join(home, ".grok", "bin")];
}

export async function findBinary(name: string): Promise<string | null> {
  const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of [...(process.env.PATH ?? "").split(delimiter), ...searchDirs()].filter(Boolean)) {
    for (const n of names) {
      const path = join(dir, n);
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {}
    }
  }
  return null;
}

function runShort(bin: string, args: string[], configEnv: string[], timeoutMs = 5_000): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: scrubbedEnv(configEnv), stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", () => {});
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

async function signedIn(spec: Spec, bin: string): Promise<{ ok: boolean; listed?: CliModel[] }> {
  if (spec.bin === "codex") return { ok: (await runShort(bin, ["login", "status"], spec.configEnv)).code === 0 };
  if (spec.bin === "claude") {
    const r = await runShort(bin, ["auth", "status", "--json"], spec.configEnv);
    return { ok: (json(r.stdout.trim())?.loggedIn as boolean | undefined) ?? r.code === 0 };
  }
  if (spec.modelsCommand) {
    const r = await runShort(bin, spec.modelsCommand, spec.configEnv, 20_000);
    const listed = (spec.modelLines ?? agyModels)(r.stdout);
    return { ok: r.code === 0 && listed.length > 0, listed };
  }
  return { ok: false };
}

const bins = new Map<CliName, string | null>();

/** Which apps are on this computer, signed in, and the models each offers. */
export async function detect(): Promise<CliStatus[]> {
  const out = await Promise.all(
    (Object.keys(SPECS) as CliName[]).map(async (name): Promise<CliStatus | null> => {
      const spec = SPECS[name];
      const bin = await findBinary(spec.bin);
      bins.set(name, bin);
      if (!bin) return null;
      const v = await runShort(bin, ["--version"], spec.configEnv);
      const s = await signedIn(spec, bin).catch(() => ({ ok: false }) as { ok: boolean; listed?: CliModel[] });
      const catalog = (spec.catalog && (await spec.catalog().catch(() => null))) || s.listed || null;
      const known = spec.knownModels.map((id) => ({ id, name: id === "default" ? `${spec.label}'s default` : id }));
      return {
        name,
        installed: true,
        signedIn: s.ok,
        version: v.stdout.trim().split("\n")[0] || undefined,
        models: catalog?.length ? [known[0]!, ...catalog] : known,
        login: spec.login,
      };
    }),
  );
  return out.filter((s): s is CliStatus => !!s);
}

export const label = (name: CliName) => SPECS[name].label;

/** Runs one turn: yields the reply as it comes. Throws with the app's reason when it fails. */
export async function* generate(name: CliName, model: string, system: string, prompt: string, signal: AbortSignal): AsyncGenerator<string> {
  const spec = SPECS[name];
  const bin = bins.get(name) ?? (await findBinary(spec.bin));
  if (!bin) throw new Error(`${spec.label} isn't installed on this computer`);
  const dir = await mkdtemp(join(tmpdir(), "piair-cli-"));
  const fullPrompt = spec.systemFlag ? prompt : `${system}\n\n${prompt}`;
  const child = spawn(bin, spec.args(model, system, fullPrompt, dir), { cwd: dir, env: scrubbedEnv(spec.configEnv), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4_000)));
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (e) => {
      stderr += String(e);
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  child.stdin!.on("error", () => {});
  child.stdin!.end(spec.promptInArgs ? "" : fullPrompt);
  const kill = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  signal.addEventListener("abort", kill, { once: true });
  const state = newState();
  try {
    for await (const line of createInterface({ input: child.stdout! })) {
      if (signal.aborted) break;
      for (const piece of spec.parse(line, state)) yield piece;
      if (state.error) throw new Error(state.error);
    }
    const code = await exited;
    if (state.error) throw new Error(state.error);
    if (!state.done && code !== 0 && !signal.aborted) {
      const detail = (state.lastError || stderr).trim().slice(-400);
      throw new Error(`${spec.label} stopped (${code})${detail ? `: ${detail}` : ""}`);
    }
  } finally {
    signal.removeEventListener("abort", kill);
    kill();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
