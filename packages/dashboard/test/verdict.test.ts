import { expect, test } from "bun:test";
import { VERDICT_MEANING, VERDICT_WORDS, scoreLabel, verdictOf } from "../lib/verdict";

test("every verdict has a word and a meaning, so no badge can render blank", () => {
  for (const v of ["ok", "watch", "alert", "unavailable"] as const) {
    expect(VERDICT_WORDS[v]).toBeTruthy();
    expect(VERDICT_MEANING[v].length).toBeGreaterThan(20);
  }
});

test("a refusal does not render as a zero score", () => {
  // The whole point: `ok` at 0 and `unavailable` at 0 are opposite findings — "we looked and
  // saw nothing" against "we could not look" — and printing `0` for both made the page
  // unreadable. `unavailable` never gets a number.
  expect(scoreLabel(0, "ok")).toBe("0");
  expect(scoreLabel(42, "watch")).toBe("42");
  expect(scoreLabel(0, "unavailable")).toBe("—");
  expect(scoreLabel(7, "unavailable")).toBe("—");
});

test("the meaning of a refusal says it is a refusal, not a mild ok", () => {
  expect(VERDICT_MEANING.unavailable.toLowerCase()).toContain("no verdict");
  expect(VERDICT_MEANING.ok.toLowerCase()).toContain("nothing");
});

test("verdictOf still matches the engine's bands", () => {
  expect(verdictOf(0)).toBe("ok");
  expect(verdictOf(19)).toBe("ok");
  expect(verdictOf(20)).toBe("watch");
  expect(verdictOf(49)).toBe("watch");
  expect(verdictOf(50)).toBe("alert");
});
