// A bank this tool creates must end up under git, because the doctrine's rule on superseding a fact
// depends on one: "edit the claim in place, git holds the prior value". Without a repo that sentence
// is false and an in-place edit destroys the old value with no undo.
//
// ⛔ The gap was found by running the system, not by reading it: on 2026-09-19 two independent pi
// sessions built a project and created its bank, and NEITHER ran git init, even though the
// doctrine's bootstrap step says to do it immediately. An instruction with no reach is not a
// guarantee, so the tool performs it.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { initBankGit } from "../src/memory-bank.ts";

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bank-git-"));
const isRepo = (d: string) => {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: d, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8",
    }).trim() === "true";
  } catch {
    return false;
  }
};

describe("initBankGit", () => {
  test("a fresh bank directory gets a git repo", () => {
    const d = mkTmp();
    expect(isRepo(d)).toBe(false);
    expect(initBankGit(d)).toBe(true);
    expect(isRepo(d)).toBe(true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("it ignores the index lock, which is transient and per-process", () => {
    const d = mkTmp();
    initBankGit(d);
    expect(fs.readFileSync(path.join(d, ".gitignore"), "utf8")).toContain(".MEMORY.md.lock");
    fs.rmSync(d, { recursive: true, force: true });
  });

  // A project bank is <project>/.pi/memory. Committing into the project's repo would put the notes
  // in its history and on GitHub with the next push, so the bank gets its own repo and the project
  // ignores it through its local exclude file (no project file changes).
  test("a bank inside a project repo gets its own repo, hidden from the project", () => {
    const outer = mkTmp();
    execFileSync("git", ["init", "-q"], { cwd: outer, stdio: "ignore" });
    const inner = path.join(outer, ".pi", "memory");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, "a.md"), "note\n");
    expect(initBankGit(inner)).toBe(true);
    expect(fs.existsSync(path.join(inner, ".git"))).toBe(true);
    expect(fs.readFileSync(path.join(outer, ".git", "info", "exclude"), "utf8")).toContain("/.pi/memory/\n");
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: outer, encoding: "utf8" });
    expect(status).toBe("");
    // a second call is a no-op and adds no second exclude line
    expect(initBankGit(inner)).toBe(false);
    const lines = fs.readFileSync(path.join(outer, ".git", "info", "exclude"), "utf8").split("\n");
    expect(lines.filter((l) => l === "/.pi/memory/").length).toBe(1);
    fs.rmSync(outer, { recursive: true, force: true });
  });

  // The note is the thing actually being asked for. Losing it because git is missing or broken would
  // trade the whole point of the call for a convenience.
  test("an unusable git costs the caller nothing but the repo", () => {
    const d = mkTmp();
    const realPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(initBankGit(d)).toBe(false);
    } finally {
      process.env.PATH = realPath;
    }
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("it does not commit — messages in these banks are hand-written and worth reading", () => {
    const d = mkTmp();
    initBankGit(d);
    let commits = "";
    try {
      commits = execFileSync("git", ["log", "--oneline"], {
        cwd: d, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8",
      });
    } catch {
      commits = "";   // no commits yet is exactly the expected state
    }
    expect(commits.trim()).toBe("");
    fs.rmSync(d, { recursive: true, force: true });
  });
});
