// Memory in Hermes' style (the idea, not its code): small capped notes the model curates, one per
// viewer, one per stream, one about itself, plus full-text search over everything said.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CAPS = { viewer: 600, stream: 2000, self: 1500 } as const;
export type About = keyof typeof CAPS;

let root = "";
let db: Database | null = null;

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function open(dir: string, keepDays: number) {
  root = join(dir, "memory");
  for (const sub of ["viewers", "streams"]) mkdirSync(join(root, sub), { recursive: true });
  db = new Database(join(dir, "piair.sqlite"));
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE VIRTUAL TABLE IF NOT EXISTS lines USING fts5(text, who, platform UNINDEXED, viewer UNINDEXED, role UNINDEXED, day UNINDEXED, ts UNINDEXED)");
  const cutoff = Date.now() - keepDays * 86_400_000;
  db.run("DELETE FROM lines WHERE CAST(ts AS INTEGER) < ?", [cutoff]);
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80);

function notePath(about: About, who?: { platform: string; id: string }) {
  if (about === "viewer") {
    if (!who) throw new Error("a viewer note needs the viewer");
    const d = join(root, "viewers", safe(who.platform));
    mkdirSync(d, { recursive: true });
    return join(d, `${safe(who.id)}.md`);
  }
  if (about === "stream") return join(root, "streams", `${today()}.md`);
  return join(root, "self.md");
}

export function readNote(about: About, who?: { platform: string; id: string }): string {
  const p = notePath(about, who);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Adds to a note (or replaces it). Over the cap it fails with the note as it is, so the model
 * rewrites it shorter instead of letting it grow. */
export function writeNote(about: About, note: string, replace: boolean, who?: { platform: string; id: string }): string {
  const cap = CAPS[about];
  const current = readNote(about, who);
  const next = replace ? note.trim() : [current.trim(), note.trim()].filter(Boolean).join("\n");
  if (next.length > cap) {
    throw new Error(`That would make the ${about} note ${next.length} characters; the limit is ${cap}. Rewrite the whole note shorter with replace: true. The note now:\n${current}`);
  }
  writeFileSync(notePath(about, who), next + "\n");
  return next;
}

export function record(role: "viewer" | "streamer" | "piair", text: string, who = "", platform = "", viewer = "") {
  db?.run("INSERT INTO lines (text, who, platform, viewer, role, day, ts) VALUES (?, ?, ?, ?, ?, ?, ?)", [text, who, platform, viewer, role, today(), String(Date.now())]);
}

export function search(query: string, who?: string, limit = 8) {
  if (!db) return [];
  // words only, each quoted: chat text can't inject FTS syntax
  const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
  if (!words.length) return [];
  const q = words.map((w) => `"${w}"`).join(" OR ");
  const rows = who
    ? db.query("SELECT text, who, role, day FROM lines WHERE lines MATCH ? AND who = ? ORDER BY rank LIMIT ?").all(q, who, limit)
    : db.query("SELECT text, who, role, day FROM lines WHERE lines MATCH ? ORDER BY rank LIMIT ?").all(q, limit);
  return rows as { text: string; who: string; role: string; day: string }[];
}
