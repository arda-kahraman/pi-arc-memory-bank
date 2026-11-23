// The write path has to produce exactly what pi-bank-verify reads, or the only tool that creates
// memories is blind to the conventions it is meant to produce — which is what forced every note to
// be saved and then hand-edited, bypassing the lean gate and the index lock.
//
// mergeExtras is the risky half: it edits an existing frontmatter block with regexes, and Claude
// Code normalises that block by moving custom keys inside `metadata:`. Matching only at column 0
// would append a duplicate and make which value wins an accident of parser order.
import { describe, expect, test } from "bun:test";
import { assertsIssue, mergeExtras, renderExtras } from "../src/memory-bank.ts";

describe("renderExtras", () => {
  test("emits nothing when there is nothing to add", () => {
    expect(renderExtras({})).toEqual([]);
  });

  test("renders host, an asserts block and a recorded size reason", () => {
    expect(renderExtras({ host: "box", asserts: [{ absent: "/x" }], sizeJustified: "irreducible" })).toEqual([
      "host: box",
      "asserts:",
      "  - absent: /x",
      'size_justified: "irreducible"',
    ]);
  });

  test("a bare true still persists, so the exemption is at least visible to the lint", () => {
    expect(renderExtras({ sizeJustified: true })).toEqual(["size_justified: true"]);
  });

  test("quotes an assertion value containing a colon so the YAML stays parseable", () => {
    expect(renderExtras({ asserts: [{ cmd: "a: b" }] })).toEqual(["asserts:", '  - cmd: "a: b"']);
  });
});

describe("assertsIssue", () => {
  test("accepts the two recognised shapes", () => {
    expect(assertsIssue([{ path: "/a" }, { absent: "/b" }])).toBeUndefined();
  });

  // unit:/cmd: were removed from the verifier. Accepting them here would store an assertion nothing
  // checks, which reads as verified and is the worst of both worlds.
  test("rejects removed keys by name, so the author learns why rather than seeing 'unrecognised'", () => {
    expect(assertsIssue([{ unit: "u", state: "active" }])).toContain("was removed");
    expect(assertsIssue([{ cmd: "x", matches: "y" }])).toContain("was removed");
  });

  test("rejects an unrecognised shape at the write, not three weeks later in a sweep", () => {
    expect(assertsIssue([{ wobble: "nonsense" }])).toContain("no recognised key");
  });

  test("rejects a non-object entry", () => {
    expect(assertsIssue(["/just/a/string" as any])).toContain("must be an object");
  });

  test("undefined is fine — assertions are optional", () => {
    expect(assertsIssue(undefined)).toBeUndefined();
  });
});

describe("mergeExtras", () => {
  const flat = ["---", "name: n", "description: d", "host: old-box", "metadata:", "  type: project", "---"].join("\n");
  // Claude Code's normalised shape: the custom key has been moved inside metadata:.
  const nested = ["---", "name: n", "description: d", "metadata:", "  type: project", "  host: old-box", "---"].join("\n");

  test("replaces a top-level host rather than appending a second one", () => {
    const out = mergeExtras(flat, { host: "new-box" });
    expect(out.match(/host:/g)).toHaveLength(1);
    expect(out).toContain("host: new-box");
  });

  test("replaces an INDENTED host too — the shape Claude Code leaves behind", () => {
    const out = mergeExtras(nested, { host: "new-box" });
    expect(out.match(/host:/g)).toHaveLength(1);
    expect(out).toContain("host: new-box");
  });

  test("removes a whole existing asserts block, not just its first line", () => {
    const withAsserts = ["---", "name: n", "asserts:", "  - absent: /old", "  - path: /other", "metadata:", "  type: project", "---"].join("\n");
    const out = mergeExtras(withAsserts, { asserts: [{ absent: "/new" }] });
    expect(out).not.toContain("/old");
    expect(out).not.toContain("/other");
    expect(out).toContain("- absent: /new");
    expect(out.match(/asserts:/g)).toHaveLength(1);
  });

  test("leaves the block untouched when there is nothing to merge", () => {
    expect(mergeExtras(flat, {})).toBe(flat);
  });

  test("keys it is not asked to change survive", () => {
    const out = mergeExtras(flat, { host: "new-box" });
    expect(out).toContain("name: n");
    expect(out).toContain("  type: project");
  });

  test("the result still closes with --- so the frontmatter stays valid", () => {
    expect(mergeExtras(flat, { host: "b", sizeJustified: "r" }).trimEnd().endsWith("---")).toBe(true);
  });
});
