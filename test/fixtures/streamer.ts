// A program on PiAir's channel for the AI streamer mode tests: `mode` switches the mode as Lightair
// does (and says `mode_set` once it's done); `turn` runs one co-host turn in which the model (Pi's
// faux provider) asks for a tool, then reports what the tool told the model (`told`) and the
// turn's end (`turn_done`).
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import * as brain from "../../src/brain.ts";
import * as memory from "../../src/memory.ts";
import { on, run, send } from "../../src/protocol.ts";
import { setSecret } from "../../src/secrets.ts";
import * as settings from "../../src/settings.ts";
import * as streamer from "../../src/streamer.ts";
import { tempDir } from "../helpers.ts";

const faux = fauxProvider();
brain.models.setProvider(faux.provider);
settings.load(tempDir());
memory.open(settings.piairDir(), 90);
const m = faux.getModel();
settings.update({ provider: m.provider, model: m.id, voice: { vendor: "none" } });
setSecret(`provider:${m.provider}`, null).catch(() => {});

on("mode", async (msg) => {
  await streamer.setMode(msg.mode, msg.policy);
  send({ t: "mode_set", held: streamer.current().held });
});

on("turn", async (msg) => {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(msg.tool, msg.args ?? {})]),
    (context) => {
      const result = [...context.messages].reverse().find((x: any) => x.role === "toolResult") as any;
      const text = (result?.content ?? []).map((c: any) => c.text ?? "").join("");
      send({ t: "told", text, isError: !!result?.isError });
      return fauxAssistantMessage([fauxText("Okay.")]);
    },
  ]);
  await brain.cohostTurn(msg.source, "a request", { onText: () => {} }, new AbortController().signal).catch(() => {});
  send({ t: "turn_done" });
});

await run(() => setImmediate(() => process.exit(0)));
