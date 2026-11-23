// The lean gate is enforced at the write because that is the only point that scales: the 2026-08-25
// thinning cut 55% of the bank's bytes, nearly all of it narrative written mid-session, and a note
// already on disk is one somebody has to be persuaded to delete.
//
// It had no direct tests. Added 2026-09-19 during a stress pass, because the interesting parts are
// the boundaries — the 12.5% band that avoids costing a round-trip to delete one sentence, the
// 8000-char anti-ratchet clamp, and the asymmetry that lets a shrinking update through unconditionally.
import { describe, expect, test } from "bun:test";

import { contentIssues } from "../src/memory-bank.ts";

// contentIssues takes the note itself; these cases only care about lengths. Joined back into one
// string (or undefined) so each case reads as the decision it checks.
const gate = (action: "save" | "update", body: number, hook: number, justified: boolean, existing = 0) => {
  const issues = contentIssues(action, "x".repeat(body), { hook: "h".repeat(hook), sizeJustified: justified || undefined }, true, existing);
  return issues.length ? issues.join("; ") : undefined;
};

const save = (body: number, hook = 20, justified = false) => gate("save", body, hook, justified);
const update = (body: number, existing: number, hook = 20, justified = false) =>
  gate("update", body, hook, justified, existing);

describe("contentIssues — save", () => {
  test("an ordinary note passes", () => {
    expect(save(1200)).toBeUndefined();
  });

  // The band exists because a model cannot count characters: rejecting at 4001 cost a whole
  // round-trip to delete one sentence.
  test("just over target is accepted inside the band, not rejected", () => {
    expect(save(4001)).toBeUndefined();
    expect(save(4400)).toBeUndefined();
  });

  test("past the band it is refused, and the message says CUT rather than justify", () => {
    const issue = save(4600);
    expect(issue).toBeDefined();
    expect(issue).toContain("4600");
    expect(issue).toMatch(/aim under 4000/);
    expect(issue!.toLowerCase()).toContain("cut at least");
  });

  test("a bloated hook is refused on its own — it rides in every cached prefix", () => {
    expect(save(500, 201)).toBeDefined();
    expect(save(500, 200)).toBeUndefined();
  });

  // ⛔ The hook check runs BEFORE sizeJustified, so a size exemption cannot buy an oversized hook.
  test("sizeJustified does not excuse a bloated hook", () => {
    expect(save(500, 260, true)).toBeDefined();
  });

  test("sizeJustified excuses an oversized body, which is its whole purpose", () => {
    expect(save(7000, 20, true)).toBeUndefined();
  });
});

describe("contentIssues — update", () => {
  test("shrinking is always allowed, whatever the size", () => {
    expect(update(9000, 9500)).toBeUndefined();
    expect(update(20000, 20000)).toBeUndefined();
  });

  test("a big note may grow by half again", () => {
    expect(update(7000, 5000)).toBeUndefined();       // cap 7500
  });

  test("but not without limit", () => {
    expect(update(9000, 5000)).toBeDefined();
  });

  // The 8000 clamp is the anti-ratchet guard that stopped files drifting to 12K+. Without it a
  // large note could grow 1.5x forever, one edit at a time.
  test("the 8000 ceiling clamps the growth allowance, so a big note cannot ratchet", () => {
    const issue = update(12000, 9000);                // 1.5x would be 13500; clamp says no
    expect(issue).toBeDefined();
    expect(issue).toContain("limit 8000");
  });

  test("a small note still gets the 4000 floor rather than 1.5x of almost nothing", () => {
    expect(update(3900, 100)).toBeUndefined();
  });
});
