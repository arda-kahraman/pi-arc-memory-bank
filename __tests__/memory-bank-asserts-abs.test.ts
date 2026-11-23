// ⛔ A relative assertion is an unanswerable one. `tests/__init__.py` resolves against whoever runs
// the check: it passes at the write, because the session's cwd IS the project, and is unverifiable
// in the daily sweep, which runs from somewhere else. The same line means two different things
// depending on who reads it.
//
// Found by running the system on 2026-09-19: a session recorded three relative asserts, all three
// files existed, memory_write accepted them without a word, and the sweep reported all three
// unchecked. Anchoring preserves what the author meant — "this file, in this project" — and makes
// it true from anywhere.
import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import { absolutiseAsserts } from "../src/memory-bank.ts";

describe("absolutiseAsserts", () => {
  test("a relative path is anchored to the writing session's directory", () => {
    const asserts = [{ path: "tests/__init__.py" }];
    const fixed = absolutiseAsserts(asserts, "/home/user/Dev/proj");
    expect(asserts[0].path).toBe("/home/user/Dev/proj/tests/__init__.py");
    expect(fixed).toHaveLength(1);
  });

  test("absent: is anchored too — a relative negation is just as unanswerable", () => {
    const asserts = [{ absent: "build/stale.o" }];
    absolutiseAsserts(asserts, "/home/user/Dev/proj");
    expect(asserts[0].absent).toBe("/home/user/Dev/proj/build/stale.o");
  });

  // ~ is resolved by the verifier itself, and rewriting it to the writer's home would silently make
  // a portable claim machine-specific.
  test("~ and absolute paths are left exactly as written", () => {
    const asserts = [{ path: "~/Dev/x/y.md" }, { path: "/etc/fstab" }];
    expect(absolutiseAsserts(asserts, "/tmp/anywhere")).toEqual([]);
    expect(asserts[0].path).toBe("~/Dev/x/y.md");
    expect(asserts[1].path).toBe("/etc/fstab");
  });

  test("it reports what it changed, so the rewrite is never silent", () => {
    const fixed = absolutiseAsserts([{ path: "a/b.py" }], "/p");
    expect(fixed[0]).toContain("a/b.py");
    expect(fixed[0]).toContain("/p/a/b.py");
  });

  test("it survives shapes the validator would have rejected anyway", () => {
    expect(absolutiseAsserts(undefined, "/p")).toEqual([]);
    expect(absolutiseAsserts([null as any, 7 as any], "/p")).toEqual([]);
  });

  test("normalisation collapses .. rather than storing a path nobody can read", () => {
    const asserts = [{ path: "../sibling/f.txt" }];
    absolutiseAsserts(asserts, "/home/user/Dev/proj");
    expect(asserts[0].path).toBe(path.resolve("/home/user/Dev/proj", "../sibling/f.txt"));
    expect(asserts[0].path).toBe("/home/user/Dev/sibling/f.txt");
  });
});
