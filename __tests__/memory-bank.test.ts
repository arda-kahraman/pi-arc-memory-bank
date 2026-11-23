import { describe, expect, test } from "bun:test";

import { contentIssues, leanGateNudge } from "../src/memory-bank.ts";

// contentIssues takes the note itself; these cases only care about lengths. Joined back into one
// string (or undefined) so each case reads as the decision it checks.
const gate = (action: "save" | "update", body: number, hook: number, justified: boolean, existing = 0) => {
  const issues = contentIssues(action, "x".repeat(body), { hook: "h".repeat(hook), sizeJustified: justified || undefined }, true, existing);
  return issues.length ? issues.join("; ") : undefined;
};

describe("contentIssues", () => {
  test("passes lean saves, rejects narrative-sized ones", () => {
    expect(gate("save", 2000, 100, false)).toBeUndefined();
    expect(gate("save", 5000, 100, false)).toContain("aim under 4000");
    expect(gate("save", 5000, 100, true)).toBeUndefined();
  });

  test("update cap: 4000 floor, 1.5× growth, 8000 ceiling, shrink always passes", () => {
    expect(gate("update", 3800, 100, false, 500)).toBeUndefined(); // floor: small file absorbing new knowledge
    expect(gate("update", 5800, 100, false, 4000)).toBeUndefined(); // within 1.5×
    expect(gate("update", 5000, 100, false, 2000)).toContain("aim under 4000");
    expect(gate("update", 8200, 100, false, 8000)).toContain("aim under 8000"); // ratchet killed
    expect(gate("update", 8900, 100, false, 9000)).toBeUndefined(); // thinning never blocked
    expect(gate("update", 8200, 100, true, 8000)).toBeUndefined(); // sizeJustified still opens the ceiling
  });

  test("hook length is capped regardless of justification", () => {
    expect(gate("save", 100, 220, true)).toContain("hook is 220 chars");
  });

  // 2026-09-12: marginal overshoots used to cost a whole round-trip. They are now accepted inside a
  // ~12% band and nudged instead, while real bloat and the 8000 anti-ratchet ceiling still reject.
  test("tolerance band accepts marginal overshoot, still rejects real bloat", () => {
    expect(gate("save", 4038, 100, false)).toBeUndefined(); // observed rejection, 0.9% over
    expect(gate("save", 4320, 100, false)).toBeUndefined(); // observed rejection, 8% over
    expect(gate("save", 4606, 100, false)).toContain("limit 4500"); // 15% over still cut
    expect(gate("save", 9428, 100, false)).toContain("limit 4500");
    expect(gate("save", 100, 185, false)).toBeUndefined(); // observed hook rejection
    expect(gate("save", 100, 241, false)).toContain("limit 200");
  });

  test("the 8000 ceiling is NOT widened by the band", () => {
    expect(gate("update", 8200, 100, false, 8000)).toContain("aim under 8000");
  });

  test("nudge fires only inside the band and never on a shrink", () => {
    expect(leanGateNudge("save", 4320, 100)).toContain("body 4320 (target 4000)");
    expect(leanGateNudge("save", 100, 185)).toContain("hook 185 (target 160)");
    expect(leanGateNudge("save", 2000, 100)).toBe("");
    expect(leanGateNudge("update", 3000, 100, 9000)).toBe(""); // shrinking is never nagged
  });
});
