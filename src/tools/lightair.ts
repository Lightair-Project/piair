// Lightair's tools: the same names, methods and parameters as Lightair's MCP server
// (lightair-tools.json, synced from lightair-remote's `TOOLS` by scripts/sync-mcp-tools.ts).
import table from "./lightair-tools.json" with { type: "json" };
import { call } from "../protocol.ts";
import { text, type Tool } from "./types.ts";

type Entry = (typeof table)[number];

/** Tools PiAir leaves out: it talks instead of writing to chat, and doesn't run raw command batches. */
const LEFT_OUT = new Set(["send_chat", "run_commands"]);

function methodOf(t: Entry, args: Record<string, unknown>): string {
  const action = () => {
    const a = String(args.action ?? "status");
    delete args.action;
    return a;
  };
  if (t.name === "recording") return `record.${action()}`;
  if (t.name === "streaming") return `stream.${action()}`;
  if (t.name === "virtual_camera") return `vcam.${action()}`;
  return t.method;
}

export function lightairTools(): Tool[] {
  return table
    .filter((t) => !LEFT_OUT.has(t.name))
    .map((t) => ({
      name: t.name,
      label: t.title,
      description: t.description,
      parameters: { type: "object", properties: t.properties, required: t.required, additionalProperties: true },
      untrustedOk: t.readOnly,
      async execute(_id: string, params: any) {
        const args = { ...(params ?? {}) };
        const method = methodOf(t, args);
        const result = await call(method, args, 30_000);
        if (method === "screenshot" && result?.data) {
          return {
            content: [
              { type: "image" as const, data: result.data, mimeType: result.mime ?? "image/png" },
              { type: "text" as const, text: `The program, ${result.width}×${result.height}` },
            ],
            details: {},
          };
        }
        return text(JSON.stringify(result ?? null).slice(0, 12_000));
      },
    }));
}
