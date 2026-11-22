// Prototype 1: does Pi stream text fast enough to speak? Measures time to first token and to the
// first complete sentence (what the voice can start on).
import { createModels } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";

const models = createModels({ identity: { attribution: null } });
models.setProvider(googleProvider());
const id = process.argv[2] ?? "gemini-2.5-flash";
const model = models.getModel("google", id);
if (!model) { console.log("models:", models.getModels("google").map(m => m.id).join(" ")); process.exit(1); }
const runs = Number(process.argv[3] ?? 3);
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  let first = 0, sentence = 0, text = "";
  const s = models.streamSimple(model, {
    systemPrompt: "You are a cheerful co-host on a live stream. Answer in two short spoken sentences, no markdown.",
    messages: [{ role: "user", content: `Chat from viewer kiwi_${i}: what game should we play next?`, timestamp: Date.now() }],
  }, { reasoning: "minimal" } as any);
  for await (const e of s) {
    if (e.type === "text_delta") {
      if (!first) first = performance.now() - t0;
      text += e.delta;
      if (!sentence && /[.!?](\s|$)/.test(text)) sentence = performance.now() - t0;
    }
    if (e.type === "error") console.log("error", e.error.errorMessage);
  }
  console.log(JSON.stringify({ model: id, firstToken: Math.round(first), firstSentence: Math.round(sentence), total: Math.round(performance.now() - t0), text }));
}
