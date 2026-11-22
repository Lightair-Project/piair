// From the model's streamed text to what the voice says (design §5.1, §7.1): pieces cut at
// sentence ends, the first one early; nothing unsayable or unsafe goes out.
import { describe, expect, test } from "bun:test";
import { moderate, speakable, Splitter } from "../src/speech.ts";

/** The pieces a stream of deltas makes. */
function pieces(...deltas: string[]) {
  const out: string[] = [];
  const s = new Splitter((p) => out.push(p));
  for (const d of deltas) s.push(d);
  s.end();
  return out;
}

describe("the splitter", () => {
  test("cuts at sentence ends, however the text arrives", () => {
    expect(pieces("Hello the", "re! How are", " you? Fine.")).toEqual(["Hello there!", "How are you?", "Fine."]);
  });

  test("doesn't cut inside abbreviations or numbers", () => {
    expect(pieces("Ask Dr. Smith about version 3.5 today. Then rest.")).toEqual([
      "Ask Dr. Smith about version 3.5 today.",
      "Then rest.",
    ]);
  });

  test("lets the voice start sooner: a long first sentence goes at a comma while the rest streams", () => {
    const out: string[] = [];
    const s = new Splitter((p) => out.push(p));
    s.push("This first sentence runs on for quite a while, then it");
    expect(out).toEqual(["This first sentence runs on for quite a while,"]);
    s.push(" ends here. Later ones run on for quite a while too, and wait");
    s.push(" for their end.");
    s.end();
    expect(out.slice(1)).toEqual(["then it ends here.", "Later ones run on for quite a while too, and wait for their end."]);
  });

  test("what's left when the reply ends is said too", () => {
    expect(pieces("No full stop at the end")).toEqual(["No full stop at the end"]);
  });
});

describe("what's never read out", () => {
  test("links are said as 'a link'", () => {
    expect(speakable("Check https://example.com/x?y=1 for more")).toBe("Check a link for more");
    expect(speakable("See [the docs](https://example.com) now")).toBe("See the docs now");
  });

  test("markdown and emoji aren't spoken", () => {
    expect(speakable("**Big** news 🎉 for `everyone`")).toBe("Big news for everyone");
  });

  for (const [what, line] of [
    ["an email address", "write to maya.k+stream@example.org"],
    ["a phone number", "call me on +1 415 555 0134"],
    ["a long number", "the code is 48213377"],
    ["a street address", "I live at 221 Baker Street"],
  ] as const) {
    test(`a sentence with ${what} fails moderation`, () => {
      expect(moderate(line, false).ok).toBe(false);
    });
  }
});

describe("moderation", () => {
  test("ordinary talk passes", () => {
    expect(moderate("That was a great run, see you in 5 minutes!", true).ok).toBe(true);
  });

  test("slurs fail always; swearing only when family friendly", () => {
    expect(moderate("you absolute faggot", false).ok).toBe(false);
    expect(moderate("well shit, that hurt", true).ok).toBe(false);
    expect(moderate("well shit, that hurt", false).ok).toBe(true);
  });

  test("spammed characters fail", () => {
    expect(moderate("lolllllllllll", false).ok).toBe(false);
  });
});
