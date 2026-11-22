// Tools for talking: memory and the avatar's face.
import * as memory from "../memory.ts";
import { text, type Tool } from "./types.ts";

/** The viewers in the current turn, by display name (so `remember` can name one). */
export const turnViewers = new Map<string, { platform: string; id: string }>();

export function talkTools(): Tool[] {
  return [
    {
      name: "remember",
      label: "Remember",
      description:
        "Keeps a short note for later streams. about: viewer (needs who, their display name from chat), stream (today's stream) or self (things about you the streamer told you). Write facts in your own words; never copy chat text. Notes are small: when one is full, rewrite it with replace: true.",
      parameters: {
        type: "object",
        properties: {
          about: { type: "string", enum: ["viewer", "stream", "self"] },
          who: { type: "string", description: "The viewer's display name (about: viewer)" },
          note: { type: "string" },
          replace: { type: "boolean", description: "Replace the whole note instead of adding" },
        },
        required: ["about", "note"],
      },
      untrustedOk: true,
      async execute(_id: string, p: any) {
        const who = p.about === "viewer" ? turnViewers.get(String(p.who ?? "")) : undefined;
        if (p.about === "viewer" && !who) throw new Error(`No viewer called ${p.who} in this turn`);
        memory.writeNote(p.about, String(p.note ?? ""), !!p.replace, who, p.about === "viewer" ? String(p.who) : undefined);
        return text("Noted.");
      },
    },
    {
      name: "recall",
      label: "Recall",
      description: "Searches your notes and everything said on past streams (chat, the streamer, you). who: limit to one viewer's display name.",
      parameters: { type: "object", properties: { query: { type: "string" }, who: { type: "string" } }, required: ["query"] },
      untrustedOk: true,
      async execute(_id: string, p: any) {
        const rows = memory.search(String(p.query ?? ""), p.who ? String(p.who) : undefined);
        if (!rows.length) return text("Nothing found.");
        return text(rows.map((r) => (r.role === "note" ? `Note about ${r.who}: ${r.text}` : `${r.day} ${r.role === "viewer" ? r.who : r.role}: ${r.text}`)).join("\n"));
      },
    },
  ];
}
