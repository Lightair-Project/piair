// Memory (design §8): small capped notes the model curates, kept across restarts in the data
// folder, and full-text search over everything said.
import { afterEach, describe, expect, jest, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as memory from "../src/memory.ts";
import { tempDir } from "./helpers.ts";

const maya = { platform: "twitch", id: "42" };

afterEach(() => jest.useRealTimers());

describe("caps", () => {
  test("a note that would go over its cap isn't written, and the model is shown the note to rewrite", () => {
    memory.open(tempDir(), 90);
    memory.writeNote("viewer", "Maya. Likes Stardew Valley.", false, maya);
    const tooLong = "x".repeat(memory.CAPS.viewer);
    expect(() => memory.writeNote("viewer", tooLong, false, maya)).toThrow("Likes Stardew Valley.");
    expect(memory.readNote("viewer", maya).trim()).toBe("Maya. Likes Stardew Valley.");
  });

  test("a rewrite that fits replaces the note", () => {
    memory.open(tempDir(), 90);
    memory.writeNote("viewer", "Maya.", false, maya);
    memory.writeNote("viewer", "Has a cat called Biscuit.", false, maya);
    memory.writeNote("viewer", "Maya, cat Biscuit.", true, maya);
    expect(memory.readNote("viewer", maya).trim()).toBe("Maya, cat Biscuit.");
  });

  test("every kind of note has its cap", () => {
    memory.open(tempDir(), 90);
    for (const about of ["viewer", "stream", "self"] as const) {
      expect(() => memory.writeNote(about, "y".repeat(memory.CAPS[about] + 1), true, maya)).toThrow();
    }
  });
});

test("notes survive a restart on the same data folder", () => {
  const dir = tempDir();
  memory.open(dir, 90);
  memory.writeNote("viewer", "Maya, cat Biscuit.", false, maya);
  memory.writeNote("stream", "Speedrun night.", false);
  memory.writeNote("self", "The streamer calls me Pi.", false);
  memory.open(tempDir(), 90); // another folder in between: nothing is kept in memory
  expect(memory.readNote("viewer", maya)).toBe("");
  memory.open(dir, 90);
  expect(memory.readNote("viewer", maya).trim()).toBe("Maya, cat Biscuit.");
  expect(memory.readNote("stream").trim()).toBe("Speedrun night.");
  expect(memory.readNote("self").trim()).toBe("The streamer calls me Pi.");
});

test("viewers with the same id on two platforms have their own notes", () => {
  memory.open(tempDir(), 90);
  memory.writeNote("viewer", "On Twitch.", false, maya);
  memory.writeNote("viewer", "On YouTube.", false, { platform: "youtube", id: "42" });
  expect(memory.readNote("viewer", maya).trim()).toBe("On Twitch.");
});

describe("full-text search", () => {
  test("finds what was said, after a restart too, and only one viewer's when asked", () => {
    const dir = tempDir();
    memory.open(dir, 90);
    memory.record("viewer", "my cat Biscuit knocked the mic over", "kiwi_bird", "twitch", "42");
    memory.record("viewer", "biscuits for everyone", "crumbs", "twitch", "7");
    memory.record("piair", "Hello chat");
    memory.open(dir, 90);
    expect(memory.search("Biscuit").map((r) => r.who).sort()).toEqual(["kiwi_bird"]);
    expect(memory.search("cat mic", "kiwi_bird")).toHaveLength(1);
    expect(memory.search("Biscuit", "crumbs")).toEqual([]);
  });

  test("chat text can't break the search with query syntax", () => {
    memory.open(tempDir(), 90);
    memory.record("viewer", "hello there", "a", "twitch", "1");
    expect(() => memory.search('" OR * NEAR( hello) AND -')).not.toThrow();
    expect(memory.search('" OR * NEAR( hello) AND -').map((r) => r.text)).toEqual(["hello there"]);
  });

  test("history older than the days kept is dropped at start", () => {
    jest.useFakeTimers();
    const dir = tempDir();
    memory.open(dir, 30);
    memory.record("viewer", "an old line about Biscuit", "kiwi_bird", "twitch", "42");
    jest.advanceTimersByTime(31 * 86_400_000);
    memory.record("viewer", "a new line about Biscuit", "kiwi_bird", "twitch", "42");
    memory.open(dir, 30);
    expect(memory.search("Biscuit").map((r) => r.text)).toEqual(["a new line about Biscuit"]);
  });
});

describe("notes are searched too", () => {
  const notes = (query: string, who?: string) => memory.search(query, who).filter((r) => r.role === "note");

  test("a note is found by its words, and only for its viewer when one is asked for", () => {
    memory.open(tempDir(), 90);
    memory.writeNote("viewer", "Maya. Has a cat called Biscuit.", false, maya, "kiwi_bird");
    memory.writeNote("viewer", "Likes Stardew Valley.", false, { platform: "twitch", id: "7" }, "crumbs");
    expect(notes("Biscuit").map((r) => r.text)).toEqual(["Maya. Has a cat called Biscuit."]);
    expect(notes("Biscuit", "kiwi_bird")).toHaveLength(1);
    expect(notes("Biscuit", "crumbs")).toEqual([]);
  });

  test("still found after a restart, even with the search index gone (the note files are the truth)", () => {
    const dir = tempDir();
    memory.open(dir, 90);
    memory.writeNote("viewer", "Has a cat called Biscuit.", false, maya, "kiwi_bird");
    memory.writeNote("self", "The streamer calls me Pi.", false);
    memory.open(dir, 90);
    expect(notes("Biscuit", "kiwi_bird")).toHaveLength(1);
    rmSync(join(dir, "piair.sqlite"), { force: true });
    rmSync(join(dir, "piair.sqlite-wal"), { force: true });
    rmSync(join(dir, "piair.sqlite-shm"), { force: true });
    memory.open(dir, 90);
    expect(notes("Biscuit").map((r) => r.text)).toEqual(["Has a cat called Biscuit."]);
    expect(notes("streamer calls")).toHaveLength(1);
  });

  test("after a rewrite, the old words no longer find it and the new ones do", () => {
    memory.open(tempDir(), 90);
    memory.writeNote("viewer", "Has a cat called Biscuit.", false, maya, "kiwi_bird");
    memory.writeNote("viewer", "Has a dog called Pickle.", true, maya, "kiwi_bird");
    expect(notes("Biscuit")).toEqual([]);
    expect(notes("Pickle", "kiwi_bird").map((r) => r.text)).toEqual(["Has a dog called Pickle."]);
  });
});
