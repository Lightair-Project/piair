// Tool gating by who caused the turn (design §7.1): a turn caused by chat or an event may talk,
// remember and read; only the streamer's turns may change Lightair or use the computer. Enforced
// in code, whatever the model asks for. The model here is Pi's faux provider, scripted per test.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import * as brain from "../src/brain.ts";
import * as memory from "../src/memory.ts";
import { setSecret } from "../src/secrets.ts";
import * as settings from "../src/settings.ts";
import { catchLines, tempDir } from "./helpers.ts";

const faux = fauxProvider();
let out: ReturnType<typeof catchLines>;

beforeAll(() => {
  brain.models.setProvider(faux.provider);
  const dir = tempDir();
  settings.load(dir);
  memory.open(settings.piairDir(), 90);
  const m = faux.getModel();
  settings.update({ provider: m.provider, model: m.id, voice: { vendor: "none" } });
  out = catchLines();
  // the faux model needs no key: answer the store's question before it's asked over the pipe
  setSecret(`provider:${m.provider}`, null).catch(() => {});
});
afterAll(() => out.restore());
beforeEach(() => {
  brain.resetCohost();
  out.clear();
  // a turn stopped while it waited on Lightair leaves its closing line unread: start fresh
  faux.setResponses([]);
});

/** One co-host turn in which the model asks for `tool`, then says a line. Resolves with the
 * Lightair methods PiAir called during it. Calls get no reply here: an allowed call is seen going
 * out and the turn is then stopped; a refused one never goes out and the turn ends by itself. */
async function turnAsking(source: "streamer" | "chat" | "event", tool: string, args: Record<string, string>) {
  faux.appendResponses([fauxAssistantMessage([fauxToolCall(tool, args)]), fauxAssistantMessage([fauxText("Okay.")])]);
  const ac = new AbortController();
  const started: string[] = [];
  let ended = false;
  const turn = brain
    .cohostTurn(source, "a request", { onText: () => {}, onToolStart: (n) => started.push(n) }, ac.signal)
    .catch(() => {})
    .finally(() => (ended = true));
  const methods = () => out.of("call").map((c) => c.method).filter((m) => m !== "secret.get" && m !== "secret.set");
  while (!ended && !methods().length) await new Promise((r) => setTimeout(r, 1));
  // a call that went out waits for Lightair's answer (none comes here): stop the turn, don't wait
  ac.abort();
  if (ended) await turn;
  // the model's request reached the tool step either way (else nothing was tested)
  expect(started).toContain(tool);
  return methods();
}

describe("a turn caused by chat", () => {
  test("can't change Lightair", async () => {
    expect(await turnAsking("chat", "switch_scene", { scene: "Gaming" })).toEqual([]);
  });

  test("can't use the computer", async () => {
    expect(await turnAsking("chat", "computer_task", { goal: "open Safari" })).toEqual([]);
    expect(out.of("status").some((s) => s.state === "acting")).toBe(false);
  });

  test("can still read Lightair", async () => {
    expect(await turnAsking("chat", "get_state", {})).toEqual(["state.get"]);
  });
});

test("a turn caused by an event (a raid, a paid message) is gated like chat", async () => {
  expect(await turnAsking("event", "remove_scene", { scene: "Gaming" })).toEqual([]);
});

test("the streamer's turn may change Lightair", async () => {
  expect(await turnAsking("streamer", "switch_scene", { scene: "Gaming" })).toEqual(["scene.switch"]);
});
