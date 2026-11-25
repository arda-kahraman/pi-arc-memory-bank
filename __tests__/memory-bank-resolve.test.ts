// lib/bank-verify.js MIRRORS resolveBank() from src/memory-bank.ts, because that file is TypeScript
// loaded by pi's own runtime and the shell tool cannot import it. A mirror that drifts is the worst
// failure this system has: the verifier checks a DIFFERENT bank than the session reads, with no
// error and no drift reported — it simply verifies a file nobody opens, forever.
//
// tests/maintenance compares the rule's CONSTANTS in both files. That catches a changed marker list
// but not a reordered rule, so this compares actual BEHAVIOUR: pi's real function against the
// mirror, over the cases the ordering is made of.
//
// Both sides run as subprocesses with HOME set in the child environment. Setting process.env.HOME in
// this process does not work: os.homedir() had already resolved the real home, so pi's module built
// its PROJECTS_ROOT from /home/user while the mirror honoured the override — the two disagreed for a
// reason that had nothing to do with the rule.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "mbresolve-"));
const EXT = path.join(import.meta.dir, "..", "src", "memory-bank.ts");
const MIRROR = path.join(import.meta.dir, "..", "lib", "bank-verify.js");

const env = (extra: Record<string, string> = {}) => {
  const e = { ...process.env, HOME, ...extra };
  delete e.PI_MEMORY_BANK_DIR;
  return { ...e, ...extra };
};

const fromPi = (cwd: string, extra?: Record<string, string>) =>
  execFileSync(
    "bun",
    ["-e", `const m = await import(${JSON.stringify(EXT)}); console.log(m.resolveBank(process.argv[1]).dir);`, cwd],
    { encoding: "utf8", env: env(extra) },
  ).trim();

const fromMirror = (cwd: string, extra?: Record<string, string>) =>
  execFileSync("node", [MIRROR, "--resolve", cwd], { encoding: "utf8", env: env(extra) }).trim();

const MACHINE = path.join(HOME, ".pi", "agent", "memory");
const bankOf = (p: string) => path.join(p, ".pi", "memory");
const mkbank = (d: string) => {
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "MEMORY.md"), "# Bank\n");
};

// These fixtures ARE the ordering: an exact bank beats a project root, a project root is inherited
// by its subdirectories, $HOME is never a root, and a worktree follows its main repo.
mkbank(MACHINE);
mkdirSync(path.join(HOME, "proj", "sub"), { recursive: true });
writeFileSync(path.join(HOME, "proj", "package.json"), "{}\n");
mkdirSync(path.join(HOME, "loose"), { recursive: true });
mkdirSync(path.join(HOME, "main", ".git", "worktrees", "wt"), { recursive: true });
mkdirSync(path.join(HOME, "wt"), { recursive: true });
writeFileSync(path.join(HOME, "wt", ".git"), `gitdir: ${path.join(HOME, "main", ".git", "worktrees", "wt")}\n`);
mkdirSync(path.join(HOME, "own"), { recursive: true });
writeFileSync(path.join(HOME, "own", ".git"), "");
mkbank(bankOf(path.join(HOME, "own")));

describe("bank resolution: the mirror must agree with pi", () => {
  const cases: Array<[string, string]> = [
    ["$HOME itself", HOME],
    ["a project root", path.join(HOME, "proj")],
    ["a subdirectory of a project root", path.join(HOME, "proj", "sub")],
    ["a loose directory under $HOME with no markers", path.join(HOME, "loose")],
    ["a git worktree follows its main repo", path.join(HOME, "wt")],
    ["a directory holding its own bank", path.join(HOME, "own")],
    ["a path that does not exist", path.join(HOME, "nope", "deeper")],
  ];

  for (const [name, dir] of cases) {
    test(name, () => {
      expect(fromMirror(dir)).toBe(fromPi(dir));
    });
  }

  // Agreement alone would pass if both sides moved the banks somewhere wrong together.
  const where: Array<[string, string, string]> = [
    ["$HOME uses the machine bank", HOME, MACHINE],
    ["a project root keeps its bank in <root>/.pi/memory", path.join(HOME, "proj"), bankOf(path.join(HOME, "proj"))],
    ["a subdirectory uses its project's bank", path.join(HOME, "proj", "sub"), bankOf(path.join(HOME, "proj"))],
    ["a worktree uses its main repo's bank", path.join(HOME, "wt"), bankOf(path.join(HOME, "main"))],
    ["a loose directory gets its own", path.join(HOME, "loose"), bankOf(path.join(HOME, "loose"))],
  ];
  for (const [name, dir, want] of where) {
    test(name, () => {
      expect(fromPi(dir)).toBe(want);
    });
  }

  test("PI_MEMORY_BANK_DIR overrides both identically", () => {
    const pinned = path.join(HOME, "pinned-bank");
    expect(fromMirror(HOME, { PI_MEMORY_BANK_DIR: pinned })).toBe(fromPi(HOME, { PI_MEMORY_BANK_DIR: pinned }));
  });

  test("cleanup", () => {
    rmSync(HOME, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
