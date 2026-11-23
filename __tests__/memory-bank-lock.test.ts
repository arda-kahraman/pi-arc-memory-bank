// ⛔ This lock is the ONLY concurrency guard between the two agents that write this bank. Claude
// Code does not take it at all for note bodies; it exists so that appends to the single shared
// MEMORY.md index cannot interleave and lose a line. A lost index line is worse than a lost note:
// the note survives on disk while being invisible to every future session.
//
// Untested until 2026-09-19, when a stress pass over the whole system went looking for what had
// never been exercised.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withIndexLock } from "../src/memory-bank.ts";

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bank-lock-"));

describe("withIndexLock", () => {
  test("concurrent appends do not lose a line", async () => {
    const dir = mkTmp();
    const index = path.join(dir, "MEMORY.md");
    fs.writeFileSync(index, "# Memory index\n", "utf8");

    // Read-modify-write is the shape that actually loses data: without the lock, two writers read
    // the same content and the second overwrites the first's line.
    const append = (n: number) => async () =>
      withIndexLock(dir, () => {
        const cur = fs.readFileSync(index, "utf8");
        fs.writeFileSync(index, `${cur}- line ${n}\n`, "utf8");
      });

    await Promise.all(Array.from({ length: 25 }, (_, i) => append(i)()));

    const lines = fs.readFileSync(index, "utf8").trim().split("\n");
    expect(lines).toHaveLength(26);                       // header + 25
    for (let i = 0; i < 25; i++) expect(lines).toContain(`- line ${i}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the lock file is released, not leaked", async () => {
    const dir = mkTmp();
    await withIndexLock(dir, () => undefined);
    expect(fs.existsSync(path.join(dir, ".MEMORY.md.lock"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("it is released even when the critical section throws", async () => {
    const dir = mkTmp();
    await expect(withIndexLock(dir, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(fs.existsSync(path.join(dir, ".MEMORY.md.lock"))).toBe(false);
    // and the bank is still usable afterwards rather than wedged
    await withIndexLock(dir, () => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A writer killed mid-write leaves the lock behind. Without theft, one crash wedges the bank for
  // every future session on this machine — a permanent failure from a transient one.
  test("a stale lock from a dead writer is stolen rather than wedging the bank", async () => {
    const dir = mkTmp();
    const lock = path.join(dir, ".MEMORY.md.lock");
    fs.writeFileSync(lock, "999999", "utf8");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);

    let ran = false;
    await withIndexLock(dir, () => { ran = true; });
    expect(ran).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a FRESH lock is respected, not trampled the moment it is seen", async () => {
    const dir = mkTmp();
    const lock = path.join(dir, ".MEMORY.md.lock");
    fs.writeFileSync(lock, String(process.pid), "utf8");   // just now, by someone still alive

    let ran = false;
    const pending = withIndexLock(dir, () => { ran = true; }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 120));
    expect(ran).toBe(false);                               // still waiting its turn

    fs.rmSync(lock, { force: true });                      // the other writer finishes
    await pending;
    expect(ran).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
