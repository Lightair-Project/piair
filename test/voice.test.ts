// The co-host's speech goes to Lightair as text (`say`), which speaks it with its own voices; an
// utterance is finished when Lightair says it played out.
import { afterAll, expect, test } from "bun:test";
import { catchLines } from "./helpers.ts";
import { LightairVoice, onVoiceState } from "../src/voice.ts";

const out = catchLines();
afterAll(() => out.restore());
const voice = new LightairVoice();

test("each piece is said in order, then the utterance ends", () => {
  out.clear();
  const u = voice.utterance("u1");
  u.say("Hello chat.");
  u.say("   ");
  u.say("Welcome in!");
  u.end();
  expect(out.lines().map((l) => [l.t, l.text])).toEqual([
    ["say", "Hello chat."],
    ["say", "Welcome in!"],
    ["say_end", undefined],
  ]);
});

test("an utterance with nothing said sends nothing and is finished at once", async () => {
  out.clear();
  const u = voice.utterance("u2");
  u.end();
  await u.finished;
  expect(out.lines()).toEqual([]);
});

test("it's finished when Lightair says it played out", async () => {
  const u = voice.utterance("u3");
  u.say("One sentence.");
  u.end();
  let done = false;
  u.finished.then(() => (done = true));
  onVoiceState("u3", "playing");
  await Bun.sleep(0);
  expect(done).toBe(false);
  onVoiceState("u3", "done");
  await u.finished;
});

test("cancelling stops it in Lightair and finishes it", async () => {
  out.clear();
  const u = voice.utterance("u4");
  u.say("A long sentence that gets cut.");
  u.cancel();
  await u.finished;
  expect(out.of("say_cancel").map((l) => l.utterance)).toEqual(["u4"]);
  u.say("more");
  expect(out.of("say").length).toBe(1);
});
