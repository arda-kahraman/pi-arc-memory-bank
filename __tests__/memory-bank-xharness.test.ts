// ⛔ This bank is shared with Claude Code, whose memory layer REWRITES frontmatter on every write:
// it moves top-level custom keys inside `metadata:`, adds originSessionId and modified, and — found
// 2026-09-19 by driving the real Claude Code CLI against a probe note — leaves a TRAILING SPACE
// after `metadata: ` and `asserts: `.
//
// The relocation was already known and is why both tools match `^\s*key:` rather than `^key:`. The
// trailing space was not. Anything anchored on `key:$` would silently stop finding the block, and
// the note would lose its assertions on the next pi update without anybody being told.
//
// The fixture below is the verbatim shape Claude Code produced, trailing spaces included.
import { describe, expect, test } from "bun:test";

import { mergeExtras } from "../src/memory-bank.ts";

// ⚠ The DELIMITERS matter and must be included: mergeExtras is called with
// `existing.slice(0, fmEnd + 4)`, which carries the closing `---`, and it inserts the rendered keys
// immediately before it. A fixture without delimiters strips the old keys and adds nothing, which
// looks exactly like a catastrophic bug and is purely a broken test.
//
// Note the deliberate trailing spaces after `metadata:` and `asserts:`.
const NORMALISED = [
  "---",
  "name: xharness-probe",
  'description: "Probe note carrying every custom frontmatter key."',
  "metadata: ",
  "  node_type: memory",
  "  host: myhost",
  "  asserts: ",
  "    - path: /home/user/Dev/pi-arc/bin/pi-bank-verify",
  "    - absent: /home/user/definitely-not-here",
  '  size_justified: "probe note, kept whole on purpose"',
  "  type: project",
  "  origin: pi",
  "  originSessionId: 5697fc3f-e8d6-4129-b6af-01932d99f226",
  "  modified: 2026-09-19T15:47:48.586Z",
  "---",
].join("\n");

describe("mergeExtras against Claude-Code-normalised frontmatter", () => {
  test("it replaces the indented asserts block rather than appending a second one", () => {
    const out = mergeExtras(NORMALISED, { asserts: [{ path: "/etc/fstab" }] });
    expect(out.match(/asserts:/g)).toHaveLength(1);
    expect(out).toContain("/etc/fstab");
    expect(out).not.toContain("/home/user/definitely-not-here");
  });

  test("a trailing space after `asserts:` does not hide the block", () => {
    // The whole point: `asserts: ` with a trailing space must still be found and replaced.
    expect(NORMALISED).toContain("asserts: \n");
    const out = mergeExtras(NORMALISED, { asserts: [{ absent: "/gone" }] });
    expect(out.match(/- path: \/home\/arc\/Dev\/pi-arc\/bin\/pi-bank-verify/g)).toBeNull();
    expect(out).toContain("- absent: /gone");
  });

  test("host: is replaced in place at indent 2, not duplicated at column 0", () => {
    const out = mergeExtras(NORMALISED, { host: "arcvps" });
    expect(out.match(/host:/g)).toHaveLength(1);
    expect(out).toContain("arcvps");
    expect(out).not.toContain("myhost");
  });

  test("size_justified is replaced in place too", () => {
    const out = mergeExtras(NORMALISED, { sizeJustified: "still irreducible" });
    expect(out.match(/size_justified:/g)).toHaveLength(1);
    expect(out).toContain("still irreducible");
  });

  // Claude Code's own bookkeeping must survive a pi write, or the two harnesses fight over the file.
  test("Claude Code's own keys are left alone", () => {
    const out = mergeExtras(NORMALISED, { host: "arcvps" });
    expect(out).toContain("originSessionId: 5697fc3f-e8d6-4129-b6af-01932d99f226");
    expect(out).toContain("node_type: memory");
    expect(out).toContain("type: project");
  });
});
