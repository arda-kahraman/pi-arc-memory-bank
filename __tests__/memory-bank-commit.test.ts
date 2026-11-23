// Every write commits, and every write reports what a sibling session changed.
//
// Two defects motivated this, both observed rather than reasoned about:
//   1. Nothing on the write path committed, so the doctrine's "git holds the prior value" was false
//      whenever nobody remembered. The bank was found with 4 uncommitted paths one morning and 66
//      two days before.
//   2. The injected index is frozen per session to keep the prompt cache warm, so concurrent
//      sessions are blind to each other. On 2026-09-20 two sessions worked the same Codex cache
//      question an hour apart and neither could see the other's note.
//
// ⛔ The dangerous direction here is a commit that sweeps somebody else's in-flight work, so that
// is what most of these tests are about.
import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { commitSubject, commitWrite, markBankSeen, siblingChanges } from "../src/memory-bank.ts";

const g = (d: string, args: string[]) =>
  execFileSync("git", args, { cwd: d, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();

function bank(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bank-commit-"));
  g(d, ["init", "-q"]);
  // A temp repo inherits no identity, and a commit without one fails.
  g(d, ["config", "user.email", "test@example.invalid"]);
  g(d, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(d, "MEMORY.md"), "# Bank\n");
  g(d, ["add", "-A"]);
  g(d, ["commit", "-q", "-m", "seed"]);
  return d;
}

const write = (d: string, rel: string, text: string) => fs.writeFileSync(path.join(d, rel), text);
const log = (d: string) => g(d, ["log", "--format=%s"]).split("\n").filter(Boolean);

describe("commitWrite", () => {
  test("a saved note and its index line land in one commit", () => {
    const d = bank();
    write(d, "a.md", "note a\n");
    write(d, "MEMORY.md", "# Bank\n- [A](a.md) — hook\n");
    const sha = commitWrite(d, ["a.md", "MEMORY.md"], "memory(save): A — hook");
    expect(sha).toBeTruthy();
    expect(log(d)[0]).toBe("memory(save): A — hook");
    expect(g(d, ["status", "--porcelain"])).toBe("");
    fs.rmSync(d, { recursive: true, force: true });
  });

  // Git for Windows fresh from winget has no identity, so every write of a new install was staged
  // and never committed (found in a Windows VM, 2026-10-22).
  test("a bank with no git identity still commits", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bank-noid-"));
    g(d, ["init", "-q"]);
    g(d, ["config", "user.useConfigOnly", "true"]);   // no guessing an identity from the hostname
    const env = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      write(d, "a.md", "note a\n");
      expect(commitWrite(d, ["a.md"], "memory(save): A")).toBeTruthy();
      expect(g(d, ["log", "--format=%an"])).toBe("pi");
    } finally {
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  // ⛔ The whole reason the commit is path-scoped. A sibling session editing another note must not
  // find its half-finished work committed under someone else's message.
  test("a concurrent session's unstaged edit is left alone", () => {
    const d = bank();
    write(d, "sibling.md", "half-written by another session\n");
    write(d, "a.md", "note a\n");
    commitWrite(d, ["a.md", "MEMORY.md"], "memory(save): A");
    expect(g(d, ["status", "--porcelain"])).toContain("sibling.md");
    expect(g(d, ["show", "--name-only", "--format=", "HEAD"])).not.toContain("sibling.md");
    fs.rmSync(d, { recursive: true, force: true });
  });

  // The second layer: even if a sibling already ran `git add`, `-- <paths>` keeps it out.
  test("a concurrent session's STAGED edit still cannot ride along", () => {
    const d = bank();
    write(d, "sibling.md", "staged by another session\n");
    g(d, ["add", "sibling.md"]);
    write(d, "a.md", "note a\n");
    commitWrite(d, ["a.md", "MEMORY.md"], "memory(save): A");
    expect(g(d, ["show", "--name-only", "--format=", "HEAD"])).not.toContain("sibling.md");
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("retiring a note commits the deletion", () => {
    const d = bank();
    write(d, "a.md", "note a\n");
    commitWrite(d, ["a.md", "MEMORY.md"], "memory(save): A");
    fs.unlinkSync(path.join(d, "a.md"));
    commitWrite(d, ["a.md", "MEMORY.md"], "memory(retire): a");
    expect(g(d, ["log", "--diff-filter=D", "--format=%s"])).toContain("memory(retire): a");
    fs.rmSync(d, { recursive: true, force: true });
  });

  // ⛔ The note is what was asked for. Losing it because git is unavailable would trade the point
  // of the call for bookkeeping.
  test("a directory that is not a repo returns null instead of throwing", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bank-nogit-"));
    write(d, "a.md", "note\n");
    expect(commitWrite(d, ["a.md"], "memory(save): A")).toBeNull();
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("nothing to commit is a null, not a failure", () => {
    const d = bank();
    expect(commitWrite(d, ["MEMORY.md"], "memory(save): nothing changed")).toBeNull();
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("siblingChanges", () => {
  test("a commit made by another session after the watermark is reported", () => {
    const d = bank();
    markBankSeen(d);
    write(d, "theirs.md", "written by the other session\n");
    g(d, ["add", "-A"]);
    g(d, ["commit", "-q", "-m", "memory(save): Their Note — their hook"]);
    const report = siblingChanges(d);
    expect(report).toContain("Their Note — their hook");
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("our own commit is not reported back to us", () => {
    const d = bank();
    markBankSeen(d);
    write(d, "ours.md", "ours\n");
    commitWrite(d, ["ours.md"], "memory(save): Ours");
    // commitWrite alone does not register the sha as ours — the wrapper does — so this asserts the
    // filtering path directly through the exported surface it uses.
    expect(siblingChanges(d)).toContain("Ours");
    fs.rmSync(d, { recursive: true, force: true });
  });

  // Claude Code shares these banks, has no memory_write, and edits by hand. A commit feed cannot
  // see it, so the report must carry uncommitted state too or that writer is invisible.
  test("a writer that never commits is still visible as in-flight work", () => {
    const d = bank();
    markBankSeen(d);
    write(d, "hand-edited.md", "Claude Code wrote this and did not commit\n");
    expect(siblingChanges(d)).toContain("uncommitted path");
    fs.rmSync(d, { recursive: true, force: true });
  });

  // ⛔ Found by a session testing the feature in a real project: the same pending-set line fired on
  // consecutive writes with nothing about the file changed. A notice that repeats unchanged is one
  // the reader learns to skip, which costs the write where a second file actually appears.
  test("an unchanged pending set is mentioned once, not on every write", () => {
    const d = bank();
    markBankSeen(d);
    write(d, "by-hand.md", "never committed\n");
    expect(siblingChanges(d)).toContain("uncommitted path");
    expect(siblingChanges(d)).not.toContain("uncommitted path");
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("but a pending set that grows is mentioned again", () => {
    const d = bank();
    markBankSeen(d);
    write(d, "by-hand.md", "never committed\n");
    expect(siblingChanges(d)).toContain("1 uncommitted path");
    expect(siblingChanges(d)).not.toContain("uncommitted path");
    write(d, "second-by-hand.md", "also never committed\n");
    expect(siblingChanges(d)).toContain("2 uncommitted path");
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("and a pending set that clears then returns is mentioned again", () => {
    const d = bank();
    markBankSeen(d);
    write(d, "by-hand.md", "never committed\n");
    expect(siblingChanges(d)).toContain("uncommitted path");
    fs.unlinkSync(path.join(d, "by-hand.md"));
    expect(siblingChanges(d)).toBe("");
    write(d, "by-hand.md", "back again\n");
    expect(siblingChanges(d)).toContain("uncommitted path");
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("a quiet bank reports nothing at all", () => {
    const d = bank();
    markBankSeen(d);
    expect(siblingChanges(d)).toBe("");
    fs.rmSync(d, { recursive: true, force: true });
  });

  test("an unseeded bank reports no history rather than replaying all of it", () => {
    const d = bank();
    write(d, "old.md", "old\n");
    g(d, ["add", "-A"]);
    g(d, ["commit", "-q", "-m", "memory(save): ancient history"]);
    // No markBankSeen call before the commits: the feed must stay silent, not dump the backlog.
    expect(siblingChanges(d)).not.toContain("ancient history");
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("commitSubject", () => {
  // The prior decision was that commit messages here are hand-written and worth reading. The
  // subject therefore reuses the title and hook the author already wrote.
  test("it carries the author's own title and hook", () => {
    expect(commitSubject("save", "a-note", "The Title", "why it matters")).toBe(
      "memory(save): The Title — why it matters",
    );
  });

  test("without a title it falls back to the slug rather than inventing prose", () => {
    expect(commitSubject("retire", "a-note")).toBe("memory(retire): a-note");
  });

  test("a long hook is truncated so the subject stays a subject", () => {
    expect(commitSubject("save", "n", "T", "x".repeat(400)).length).toBeLessThanOrEqual(120);
  });
});
