// The injected index is capped at 64 KB as a backstop: past that, memory bodies have leaked into
// the index and the cached prefix must not absorb it silently. One real bank here sits at 92% of
// that cap (9 notes, a 60 KB index of changelog entries), so the cut is not hypothetical.
//
// Two defects found 2026-09-19 while stress-testing: the test was in BYTES while the cut was in
// UTF-16 code units, so a non-ASCII index was never actually bounded; and the cut landed mid-line,
// leaving half an index entry — a broken link with a truncated hook, which reads like a real
// pointer rather than an obvious casualty.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_BYTES = 64 * 1024;

// The shape the extension uses, extracted so the boundary can be tested without a live session.
function capIndex(raw: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(raw, "utf8") <= MAX_BYTES) return { text: raw, truncated: false };
  let cut = Buffer.from(raw, "utf8").subarray(0, MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > 0) cut = cut.slice(0, lastNl);
  return { text: cut, truncated: true };
}

const line = (i: number, body: string) => `- [Note ${i}](note-${i}.md) — ${body}\n`;

describe("index cap", () => {
  test("an ordinary index is passed through untouched", () => {
    const raw = Array.from({ length: 50 }, (_, i) => line(i, "a short pointer")).join("");
    const out = capIndex(raw);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(raw);
  });

  test("an oversized ASCII index is cut to within the cap", () => {
    const raw = Array.from({ length: 4000 }, (_, i) => line(i, "x".repeat(60))).join("");
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(MAX_BYTES);
    const out = capIndex(raw);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  // ⛔ The regression: code-unit slicing left a non-ASCII index far over the byte cap.
  test("a non-ASCII index is bounded in BYTES, not code units", () => {
    const raw = Array.from({ length: 4000 }, (_, i) => line(i, "日本語テキスト".repeat(6))).join("");
    const out = capIndex(raw);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  test("the cut never leaves a partial replacement character", () => {
    const raw = "x".repeat(MAX_BYTES - 1) + "日本語".repeat(100);
    expect(capIndex(raw).text).not.toContain("\uFFFD");
  });

  // Half an index entry is worse than none: a broken link with a plausible-looking hook.
  test("the cut lands on a line boundary, never mid-entry", () => {
    const raw = Array.from({ length: 4000 }, (_, i) => line(i, "y".repeat(60))).join("");
    const out = capIndex(raw);
    expect(out.text.endsWith(")") || /\)\s—\s\S/.test(out.text.slice(-80))).toBe(true);
    for (const l of out.text.split("\n")) {
      if (!l.trim()) continue;
      // every surviving line is a complete pointer, not a fragment
      expect(l).toMatch(/^- \[Note \d+\]\(note-\d+\.md\) — y+$/);
    }
  });

  test("the real bank closest to the cap is still under it", () => {
    const taras = path.join(os.homedir(), ".claude/projects/-home-user-Dev-TARAS/memory/MEMORY.md");
    if (!fs.existsSync(taras)) return;            // fixture is a real bank; skip if it is gone
    const bytes = fs.statSync(taras).size;
    expect(bytes).toBeLessThan(MAX_BYTES);        // fails when it finally crosses, which is the point
  });
});
