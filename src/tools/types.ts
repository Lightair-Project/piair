import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Who caused a turn. Only the streamer (their own mic, or typing in Lightair) is trusted. Chat,
 * a guest on another heard track, and content (a video or game playing) are untrusted: they can
 * talk, remember and read, nothing else. */
export type Source = "streamer" | "guest" | "chat" | "event" | "content" | "self";

export type Tool = AgentTool<any> & {
  /** Allowed in turns caused by chat, guests or events (default false: streamer only). */
  untrustedOk?: boolean;
  /** It only reads (Lightair's read-only tools): allowed inside a computer task. */
  readOnly?: boolean;
};

export function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}
