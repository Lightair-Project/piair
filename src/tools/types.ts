import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Who caused a turn. Chat and content (a video or game playing) are untrusted: they can talk,
 * remember and read, nothing else. */
export type Source = "streamer" | "chat" | "event" | "content" | "self";

export type Tool = AgentTool<any> & {
  /** Allowed in turns caused by chat or events (default false: streamer only). */
  untrustedOk?: boolean;
};

export function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}
