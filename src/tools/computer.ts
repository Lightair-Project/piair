// Computer use: Lightair executes every action (and owns every safety switch); these tools ask.
// Coordinates are in the pixels of the latest screenshot; every action returns a new screenshot.
import { call } from "../protocol.ts";
import { text, type Tool } from "./types.ts";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(note: string) {
  const s = await call<{ image: string; width: number; height: number; cursor?: { x: number; y: number } }>("computer.screenshot", { max_width: 1280 }, 15_000);
  const where = s.cursor ? ` Pointer at ${Math.round(s.cursor.x)},${Math.round(s.cursor.y)}.` : "";
  return {
    content: [
      { type: "text" as const, text: `${note} Screen ${s.width}×${s.height}.${where} Black areas are apps you may not see or use.` },
      { type: "image" as const, data: s.image, mimeType: "image/jpeg" },
    ],
    details: {},
  };
}

const num = (description: string) => ({ type: "integer", description });
const point = { x: num("x in the screenshot's pixels"), y: num("y in the screenshot's pixels") };

function action(name: string, label: string, description: string, properties: object, required: string[], method: string, after = 250): Tool {
  return {
    name,
    label,
    description,
    parameters: { type: "object", properties, required },
    executionMode: "sequential",
    async execute(_id: string, params: any) {
      await call(method, params ?? {}, 60_000);
      await settle(after);
      return shot("Done.");
    },
  };
}

export function computerTools(): Tool[] {
  return [
    {
      name: "computer_screenshot",
      label: "Look at the screen",
      description: "A picture of the screen (the display under the pointer). Use it first, and whenever unsure.",
      parameters: { type: "object", properties: {} },
      executionMode: "sequential",
      execute: async () => shot("The screen."),
    },
    action("computer_click", "Click", "Moves the pointer there along a natural path and clicks. button: left (default), right or middle; count 2 for a double click; modifiers like [\"cmd\"].",
      { ...point, button: { type: "string", enum: ["left", "right", "middle"] }, count: { type: "integer", minimum: 1, maximum: 3 }, modifiers: { type: "array", items: { type: "string", enum: ["cmd", "ctrl", "alt", "shift"] } } }, ["x", "y"], "computer.click", 400),
    action("computer_move", "Point", "Moves the pointer there (viewers see it move), without clicking. Use it to point things out.", point, ["x", "y"], "computer.move", 100),
    action("computer_drag", "Drag", "Presses at from, drags to to, releases.", { from: { type: "object", properties: point, required: ["x", "y"] }, to: { type: "object", properties: point, required: ["x", "y"] } }, ["from", "to"], "computer.drag", 300),
    action("computer_scroll", "Scroll", "Scrolls at a point: dy > 0 down, < 0 up; dx sideways (lines).", { ...point, dx: { type: "integer" }, dy: { type: "integer" } }, ["x", "y"], "computer.scroll", 300),
    action("computer_type", "Type", "Types text where the keyboard focus is. Never into password fields (Lightair refuses).", { text: { type: "string" } }, ["text"], "computer.type", 300),
    action("computer_key", "Press keys", "Presses a key or combination, e.g. \"return\", \"escape\", \"cmd+t\", \"ctrl+shift+tab\". Quitting, closing and deleting ask the streamer first.", { keys: { type: "string" } }, ["keys"], "computer.key", 400),
    {
      name: "computer_zoom_to",
      label: "Zoom to here",
      description: "Zooms the stream's screen capture in to a point for a few seconds, to show viewers something (doesn't click).",
      parameters: { type: "object", properties: { ...point, scale: { type: "number", minimum: 1.2, maximum: 4 }, hold_s: { type: "number", minimum: 1, maximum: 15 } }, required: ["x", "y"] },
      async execute(_id: string, params: any) {
        await call("computer.zoom_to", params, 10_000);
        return text("Zoomed in.");
      },
    },
    {
      name: "computer_wait",
      label: "Wait",
      description: "Waits for something to load (seconds, at most 10), then looks again.",
      parameters: { type: "object", properties: { seconds: { type: "number", minimum: 0.2, maximum: 10 } }, required: ["seconds"] },
      executionMode: "sequential",
      async execute(_id: string, params: any) {
        await settle(Math.min(10, Math.max(0.2, Number(params?.seconds ?? 1))) * 1000);
        return shot("Waited.");
      },
    },
  ];
}
