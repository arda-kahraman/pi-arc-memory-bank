// The transcript shows one line per memory write; the model still gets the whole result.
import { expect, test } from "bun:test";

import { resultHeadline } from "../src/memory-bank.ts";

test("a write result shrinks to what happened", () => {
  expect(resultHeadline("Saved notes-text.md in C:\\Users\\a\\.claude\\projects\\x\\memory and appended its index line. Long tail.")).toBe("Saved notes-text.md");
  expect(resultHeadline("Updated a_b.md in /home/u/.claude/projects/x/memory (body edited, 120 chars).")).toBe("Updated a_b.md");
  expect(resultHeadline("Renamed old.md → new.md in /bank, index line moved.")).toBe("Renamed old.md → new.md");
  expect(resultHeadline("Nothing matched\nsecond line")).toBe("Nothing matched");
});
