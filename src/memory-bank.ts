// memory-bank.ts — put the memory bank for THIS working directory into pi's cached prefix.
//
// Why: pi's AGENTS.md only told the agent a bank existed, so recall was pull-based — two tool
// round-trips and entirely dependent on the model deciding to look. This puts the index in context
// from turn one, for the bank belonging to the directory pi was started in.
//
// BANK RESOLUTION (the part that makes it correct rather than merely present):
// A project's bank is <project>/.pi/memory, beside pi's other per-project files; the machine-wide
// bank is ~/.pi/agent/memory. The bank is resolved from the session cwd in this order:
//   1. <cwd>/.pi/memory, if it has an index;
//   2. otherwise the bank of the enclosing PROJECT ROOT — nearest ancestor holding .git or a
//      manifest — so a session started in <project>/docs uses <project>'s bank, and a project with
//      no bank yet gets the bank path for its own root (created on first write);
//   3. otherwise the cwd is treated as its own project and gets its own bank.
// It deliberately does NOT walk up into an unrelated ancestor's bank: an earlier cut did, which
// meant every new folder under $HOME silently inherited the machine-wide bank and wrote its
// project memories into it. $HOME is never treated as a project root for this reason. The
// machine-wide bank is used only when the cwd IS $HOME, when memory_write is called with
// scope:"machine", or when PI_MEMORY_BANK_SCOPE=both asks for it alongside a project bank.
// Writes go to the SAME resolved bank, so a memory recorded while working in a project lands in
// that project's bank, not in a global heap.
//
// The cache contract (do not "improve" this without reading it):
//   * The index is read ONCE per session and frozen. The identical byte string is appended to the
//     system prompt every turn — pi rebuilds the system prompt per turn, so re-injecting is
//     mandatory, but re-READING is not.
//   * It is NOT refreshed when a memory changes mid-session. Edits land at the END of long
//     sessions, where re-warming the prefix re-bills the whole context. The model already knows
//     what it just wrote; the preamble says the list is a snapshot.
//   * A missing index is frozen as "missing" too, so a file appearing mid-session cannot move the
//     prefix either.
//   * The snapshot is PERSISTED per session id, so --continue/--resume in a NEW PROCESS reuses
//     byte-identical text. Snapshots older than 30 days are pruned at session start.
//   * Snapshots are never evicted from the in-process map: eviction means a re-read on a live
//     session, which is the invalidation this extension exists to avoid.
//
// WRITE SIDE (memory_write): a tool rather than prose instructions, because prose cannot cover
// three things — the injected index is frozen, so a model appending to MEMORY.md by hand would be
// editing a stale copy; Claude Code and pi share one index with no locking between them; and the
// format is mechanical, so it can be enforced instead of requested. Removals move to
// ~/.pi/agent/memory-bank-trash/ rather than unlinking: the banks are not git repos.
//
// Env: PI_MEMORY_BANK=off disables injection. PI_MEMORY_BANK_DIR pins one bank regardless of cwd
// (used by tests). PI_MEMORY_BANK_SCOPE=both also injects the machine-wide bank when the resolved
// bank is a project one. PI_MEMORY_BANK_WRITE=off drops the write tool; =children also registers
// it in subagent children (default: parent only).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// PI_MEMORY_BANK_MACHINE_DIR pins it the way PI_MEMORY_BANK_DIR pins the project bank: a trial
// run with a real HOME must never write the real machine bank.
const HOME_BANK = process.env.PI_MEMORY_BANK_MACHINE_DIR || path.join(os.homedir(), ".pi", "agent", "memory");
const PINNED_BANK = process.env.PI_MEMORY_BANK_DIR || "";
const ALSO_GLOBAL = (process.env.PI_MEMORY_BANK_SCOPE ?? "").toLowerCase() === "both";

// Backstop only: an index is one line per memory. Past this, memory bodies have leaked into the
// index (one bank here is already 60 KB for 9 memories) and the prefix must not absorb it silently.
const MAX_BYTES = 64 * 1024;

const OFF = /^(0|off|false|no)$/i.test(process.env.PI_MEMORY_BANK ?? "");
const IS_CHILD = process.env.PI_SUBAGENT_CHILD === "1";
const CHILD_INHERITS = process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT !== "0";
const ENABLED = !OFF && (!IS_CHILD || CHILD_INHERITS);

const WRITE_MODE = (process.env.PI_MEMORY_BANK_WRITE ?? "").toLowerCase();
const WRITE_ENABLED = WRITE_MODE !== "off" && (!IS_CHILD || WRITE_MODE === "children");
const TRASH_DIR = path.join(os.homedir(), ".pi", "agent", "memory-bank-trash");
const SNAP_DIR = path.join(os.homedir(), ".pi", "agent", "memory-bank-snapshots");
const SNAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
// `_` as well as `-`: Claude Code-era banks name every note `feedback_…`/`project_…`, and a kebab-only
// slug left those notes unreachable for update/remove and made the bank's own convention unwritable.
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function indexIn(dir: string): string {
  return path.join(dir, "MEMORY.md");
}

// "Saved x.md in <bank> and appended its index line. ..." -> "Saved x.md" (also Updated, Renamed
// a.md → b.md, Moved): what the person watching needs from a write.
export function resultHeadline(text: string): string {
  return /^\S+ \S+?\.md(?: → \S+?\.md)?/.exec(text)?.[0] ?? text.split("\n")[0].slice(0, 120);
}

// A minimal pi-tui component: pi-tui's Text would be a runtime import that the test suite (run
// without pi's packages) cannot resolve. Lines are cut at the terminal width, one column per
// character, which holds for the ASCII slugs and paths these results are made of.
function textBlock(text: string, color: (s: string) => string) {
  return {
    invalidate() {},
    render(width: number): string[] {
      const w = Math.max(1, width);
      const out: string[] = [];
      for (const line of text.split("\n")) {
        const chars = [...line];
        if (!chars.length) out.push("");
        for (let i = 0; i < chars.length; i += w) out.push(color(chars.slice(i, i + w).join("")));
      }
      return out;
    },
  };
}

function bankForPath(dir: string): string {
  return path.join(dir, ".pi", "memory");
}

type Resolved = { dir: string; via: string; project: boolean; exists: boolean };

// A project root is a directory that looks like the top of a codebase. $HOME is excluded on
// purpose: treating it as a root would make every folder beneath it inherit the machine-wide bank,
// which is the bug this ordering exists to prevent.
const PROJECT_MARKERS = [".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "AGENTS.md", "CLAUDE.md"];

// A git worktree's `.git` is a FILE holding "gitdir: /main/repo/.git/worktrees/<name>". Without
// this, every isolated subagent worktree (pi-subagents isolation:"worktree") resolves to its own
// throwaway bank: the child starts memory-blind and anything it records dies with the worktree.
// Submodules point at .git/modules/... instead and stay their own project, which is correct.
function mainWorktreeOf(dir: string): string | null {
  try {
    const dotGit = path.join(dir, ".git");
    if (!fs.statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!m) return null;
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const at = m[1].trim().indexOf(marker);
    if (at <= 0) return null;
    const main = m[1].trim().slice(0, at);
    return fs.existsSync(main) ? main : null;
  } catch {
    return null;
  }
}

function findProjectRoot(start: string): string | null {
  const home = os.homedir();
  let cur = start;
  for (;;) {
    if (cur === home) return null;
    if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(cur, m)))) return mainWorktreeOf(cur) ?? cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function hasIndex(dir: string): boolean {
  return fs.existsSync(indexIn(dir));
}

// Exported ONLY so the test suite can compare this, the source of truth, against the mirror in
// bin/lib/bank-verify.js. Without a behavioural comparison the two can diverge silently and the
// verifier checks a different bank than the session reads.
export function resolveBank(cwd: string): Resolved {
  if (PINNED_BANK) return { dir: PINNED_BANK, via: "PI_MEMORY_BANK_DIR", project: false, exists: hasIndex(PINNED_BANK) };
  let cur: string;
  try {
    cur = path.resolve(cwd || process.cwd());
  } catch {
    return { dir: HOME_BANK, via: "no cwd", project: false, exists: hasIndex(HOME_BANK) };
  }

  const exact = bankForPath(cur);
  if (hasIndex(exact)) return { dir: exact, via: cur, project: exact !== HOME_BANK, exists: true };

  const root = findProjectRoot(cur);
  if (root) {
    const bank = bankForPath(root);
    const exists = hasIndex(bank);
    return {
      dir: bank,
      via: exists
        ? `project root ${root}`
        : `project root ${root} — no bank yet, one will be created here on first write`,
      project: bank !== HOME_BANK,
      exists,
    };
  }

  if (cur === os.homedir()) return { dir: HOME_BANK, via: cur, project: false, exists: hasIndex(HOME_BANK) };
  return { dir: exact, via: `${cur} — no bank yet, one will be created here on first write`, project: true, exists: false };
}

type Snapshot = { text: string; takenAt: number; bytes: number; banks: string[]; restored?: boolean };

function renderBank(dir: string, heading: string, note: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(indexIn(dir), "utf8");
  } catch {
    return null;
  }
  let truncated = false;
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) {
    // ⛔ The test is in BYTES and the old cut was in UTF-16 code units, so a non-ASCII index was not
    // actually bounded: 65536 code units of CJK or emoji is ~3x that in bytes, and the cap it
    // claims to enforce silently did not hold. Cut the buffer, then drop the partial character the
    // cut may have left.
    raw = Buffer.from(raw, "utf8").subarray(0, MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
    // And end on a whole line. Cutting mid-line leaves half an index entry — a broken link and a
    // truncated hook that reads like a real, wrong pointer rather than an obvious casualty.
    const lastNl = raw.lastIndexOf("\n");
    if (lastNl > 0) raw = raw.slice(0, lastNl);
    truncated = true;
  }
  const body = raw.trim();
  if (!body) return null;
  return (
    `# ${heading}\n\n${note}\n\nBank: \`${dir}/\`\n\n${body}\n` +
    (truncated ? "\n(index truncated at 64 KB — it has outgrown one line per memory)\n" : "")
  );
}

const SNAPSHOT_NOTE =
  "This index was read once, when this session started, and is deliberately never refreshed: it " +
  "sits in the cached prompt prefix, and rewriting it mid-session would re-bill the whole context. " +
  "If you write or edit memories during this session, your own edits are the current truth — they " +
  "will not appear below, and that is expected rather than a failure.";

// The instruction to verify was already here; the TOOL that does it was not, and an agent reading a
// note for facts has no reason to load the memory-curation skill (it triggers on memory *writing*).
// Naming it here rather than in AGENTS.md keeps it out of the block mirrored to four harnesses, and
// costs ~15 tokens once per session.
const POINTER_NOTE =
  "Every line below points at one `*.md` file in that directory and is only a pointer — read the " +
  "file itself before acting on what it summarises. Each memory reflects what was true when it was " +
  "written, so verify any file, unit, or flag it names still exists; `pi-bank-verify` checks the " +
  "mechanical part of that for this bank, and the `memory-curation` skill is the doctrine for " +
  "writing, superseding and thinning notes.";

// ⛔ Every other word injected here is about READING. Nothing said when to write, and the system was
// relying on a model volunteering — measured at one session in two: on 2026-09-19 two comparable
// projects were built from scratch in fresh directories, and only one recorded anything, despite
// both having memory_write and both being told later sessions would continue the work.
//
// It has to be short: this sits in the cached prompt prefix and is billed to every session in every
// directory. The second sentence is load-bearing in the other direction — an instruction to record
// without a bound produces the collector's fallacy, which is the failure this bank was thinned 55%
// to undo.
const RECORD_NOTE =
  "⛔ Before you finish substantial work here, record what a later session would need and could not " +
  "re-derive: a decision and why, a trap, a measured number, something that is NOT true. Use " +
  "`memory_write`. Most work needs no memory and a note nobody acts on is rent — but discovering a " +
  "trap and recording nothing is how the next session repeats the whole investigation. " +
  "⚠ Then ask one question before you write it: **would this be just as true in a different project " +
  "on this machine?** A tool, a path, a version quirk, a permission rule, a piece of hardware — if " +
  "yes, it belongs in the machine bank via scope \"machine\", and filing it here hides it from every " +
  "other project. Only what is specific to THIS codebase belongs in this bank.";

function build(cwd: string): Snapshot | null {
  const resolved = resolveBank(cwd);
  const blocks: string[] = [];
  const banks: string[] = [];
  // 2026-09-03: a project session otherwise has no way to find the machine bank (hardware,
  // power, harness traps); name it once here rather than in the cached AGENTS.md prefix.
  const machineNote =
    resolved.project && resolved.dir !== HOME_BANK && !ALSO_GLOBAL
      ? ` Machine-wide facts (hardware, power, GPU, boot, networking, local LLMs, agent tooling) are in the machine bank \`${HOME_BANK}/\` — read its MEMORY.md for those.`
      : "";
  const main = renderBank(
    resolved.dir,
    resolved.project ? "Memory bank for this project — index snapshot" : "Memory bank — index snapshot",
    `${POINTER_NOTE} Resolved from the working directory: ${resolved.via}.${machineNote}\n\n${RECORD_NOTE}\n\n${SNAPSHOT_NOTE}`,
  );
  if (main) {
    blocks.push(main);
    banks.push(resolved.dir);
  } else {
    // Covers both "no bank yet" and "bank exists but its index is empty" — the second used to
    // inject nothing at all, leaving the model unaware a bank was even available.
    // Say so rather than injecting nothing: otherwise the model has no idea a bank is available.
    // Same `Bank:` line shape as a populated bank, so the resolved path is unambiguous in the
    // prompt and so readPersisted() can still recover which bank a restored snapshot belongs to.
    blocks.push(
      `# Memory bank for this project — empty\n\n` +
        `Resolved from the working directory: ${resolved.via}.\n\n` +
        `Bank: \`${resolved.dir}/\`\n\n` +
        `No memories have been recorded here yet; memory_write writes the first one. ` +
        `Facts about the machine itself (hardware, power, harness) live in the machine-wide bank \`${HOME_BANK}/\` instead: read its MEMORY.md for those; memory_write with scope "machine" writes there.\n\n` +
        `${RECORD_NOTE}\n`,
    );
    banks.push(resolved.dir);
  }
  // 2026-08-22: was `ALSO_GLOBAL && resolved.project`, which silently skipped the machine-wide
  // bank in bare non-project directories (~/Work etc.). the user wants machine-wide facts (harness
  // playbook, hardware gotchas) in EVERY directory; only skip when the resolved bank IS the
  // machine bank (cwd = $HOME) to avoid double injection.
  if (ALSO_GLOBAL && resolved.dir !== HOME_BANK) {
    const global = renderBank(
      HOME_BANK,
      "Machine-wide memory bank — index snapshot",
      "Facts about this machine itself, injected alongside the project bank because PI_MEMORY_BANK_SCOPE=both.",
    );
    if (global) {
      blocks.push(global);
      banks.push(HOME_BANK);
    }
  }
  if (!blocks.length) return null;
  const text = blocks.join("\n");
  return { text, takenAt: Date.now(), bytes: Buffer.byteLength(text, "utf8"), banks };
}

const snapshots = new Map<string, Snapshot | null>();
const EPHEMERAL_KEY = "ephemeral-no-session-id";

// 2026-09-05: on the claude-bridge path the snapshot travels as a persistent message, so
// "already delivered" means "the ACTIVE branch carries it" — nothing else. The in-process
// Set this replaces was pre-marked only for session_start reason resume/fork: a fresh
// process loading an old session (reason "startup": pi -c, --session, pi-reboot-resume)
// injected a second copy that rode every later turn, and a first turn aborted before any
// output left the copy on a dead branch while the Set said "delivered", so the model never
// saw the index for the rest of that session.
function branchHasIndex(ctx: any): boolean {
  const entries = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(entries)) return false;
  return entries.some((e: any) => e?.type === "custom_message" && e?.customType === "memory-bank-index");
}

function sessionKey(ctx: any): string {
  return ctx?.sessionManager?.getSessionId?.() ?? "";
}

// Keyed by session id AND bank: one id used against two banks would otherwise overwrite the other's
// snapshot, and the loser would silently rebuild (losing its frozen prefix) on the next resume.
function snapFile(key: string, bank: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  const tag = crypto.createHash("sha1").update(bank).digest("hex").slice(0, 8);
  return path.join(SNAP_DIR, `${safe}-${tag}.md`);
}

function readPersisted(key: string, bank: string): Snapshot | null {
  try {
    const file = snapFile(key, bank);
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, "utf8");
    if (!text) return null;
    const banks = [...text.matchAll(/^Bank: `(.+?)\/`$/gm)].map((m) => m[1]);
    return { text, takenAt: stat.mtimeMs, bytes: Buffer.byteLength(text, "utf8"), banks, restored: true };
  } catch {
    return null;
  }
}

function persist(key: string, snap: Snapshot): void {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.writeFileSync(snapFile(key, snap.banks[0] ?? ""), snap.text, "utf8");
  } catch {
    // Persistence only helps resumed sessions; losing it must never break a turn.
  }
}

function prune(): void {
  try {
    const cutoff = Date.now() - SNAP_TTL_MS;
    for (const name of fs.readdirSync(SNAP_DIR)) {
      const file = path.join(SNAP_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        /* raced with another session */
      }
    }
  } catch {
    /* no snapshot dir yet */
  }
}

function snapshotFor(ctx: any): Snapshot | null {
  const cwd = ctx?.cwd ?? process.cwd();
  const key = sessionKey(ctx);
  if (!key) {
    if (!snapshots.has(EPHEMERAL_KEY)) snapshots.set(EPHEMERAL_KEY, build(cwd));
    return snapshots.get(EPHEMERAL_KEY) ?? null;
  }
  if (!snapshots.has(key)) {
    // A persisted snapshot is only reused if it belongs to the bank this cwd resolves to now.
    // Resuming a session from a different project would otherwise replay the previous project's
    // memories, and serving the wrong bank is worse than paying one cache re-warm.
    const bank = resolveBank(cwd).dir;
    const restored = readPersisted(key, bank);
    const usable = restored && restored.banks[0] === bank ? restored : null;
    const snap = usable ?? build(cwd);
    if (snap && !usable) persist(key, snap);
    snapshots.set(key, snap);
  }
  return snapshots.get(key) ?? null;
}

function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

// ---------------------------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------------------------

// TypeBox is an available import, but a failed import would take the READ side down with it — the
// half that matters. Runtime TypeBox schemas are plain JSON Schema anyway, so no dependency.
const WRITE_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["save", "update", "edit", "append", "rename", "move", "remove"] },
    name: { type: "string", description: "lowercase slug, words joined by - or _ (follow the bank's existing convention); the file is <name>.md" },
    title: { type: "string", description: "Display title for the index line. Required for save." },
    hook: { type: "string", description: "One line after the title in the index — what it is worth reading for. Required for save." },
    description: { type: "string", description: "Frontmatter description; used to judge relevance during recall. Required for save." },
    type: { type: "string", enum: [...MEMORY_TYPES], description: "Required for save." },
    body: { type: "string", description: "Markdown body without frontmatter. Required for save. For update it replaces the whole body; omit it to change only metadata." },
    edits: {
      type: "array",
      description: "edit (or draft:true): replacements applied to the body in order. Each oldText must match exactly once; newText \"\" deletes.",
      items: {
        type: "object",
        properties: { oldText: { type: "string" }, newText: { type: "string" } },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    },
    text: { type: "string", description: "append: markdown added at the end of the body." },
    why: { type: "string", description: "One line of reason; written as a leading **Why:** line when the body has none." },
    newName: { type: "string", description: "rename: the new slug. The index line, the name: field and [[links]] in this bank follow." },
    to: { type: "string", enum: ["here", "machine"], description: "move: the bank to move the note into (scope names the one it is in now)." },
    draft: {
      type: "boolean",
      description: "Finish a write that was staged by a refusal: send only the fix (edits, hook, why, sizeJustified, ...) and the original write completes.",
    },
    sizeJustified: {
      type: ["string", "boolean"],
      description:
        "Only for a body that is a genuine consolidation, never one not yet thinned: a short REASON, kept in the note as size_justified.",
    },
    host: {
      type: "string",
      description: "Only when the note describes a DIFFERENT machine (a deployment host, a tailnet box): its paths are then not checked here.",
    },
    asserts: {
      type: "array",
      // ⛔ Only path: and absent: exist. unit:/cmd: were deleted from the verifier (zero uses, five
      // bugs) but survived here in the schema for a day, so the tool advertised capabilities the
      // runtime refuses — a real session spent a call on {cmd, matches} before concluding the
      // rejection was not its own syntax error. A schema is a promise; keep it equal to the code.
      description:
        "Checks for pi-bank-verify that prose cannot express: {path} must exist, {absent} must NOT. The only two kinds; paths in the prose are checked without listing them here.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          absent: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    scope: {
      type: "string",
      enum: ["here", "machine"],
      description: "here (default): the current directory's bank. machine: the machine-wide bank.",
    },
  },
  required: ["action", "name"],
  additionalProperties: false,
};

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// The text a runWrite result carries, for re-raising a fail() as the thrown tool error.
function resultText(result: any): string {
  return (result?.content ?? [])
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

// title and hook come from the model and are written into a LINE-oriented index. A newline in
// either forges extra entries (verified: a hook containing "\n- [Fake](fake.md) - x" added a bogus
// memory to the index), and brackets break the link itself.
function oneLine(value: string, stripBrackets = false): string {
  const flat = String(value ?? "")
    .replace(/\s+/g, " ")
    // "](" is the shape this file matches on to find an entry's line; leaving it inside free text
    // would let a hook impersonate a link and confuse upsert/drop later.
    .replace(/\]\(/g, "] (")
    .trim();
  return stripBrackets ? flat.replace(/[[\]]/g, "") : flat;
}

function memoryFile(dir: string, name: string): string | null {
  if (!SLUG.test(name) || name.length > 100 || name === "MEMORY") return null;
  const file = path.join(dir, `${name}.md`);
  return path.resolve(file).startsWith(path.resolve(dir) + path.sep) ? file : null;
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

// A bank this tool creates gets a git repo, because the doctrine's rule on superseding a fact
// depends on one: "edit the claim in place, git holds the prior value". Without a repo that
// sentence is false and an in-place edit simply destroys the old value.
//
// ⛔ This is not theoretical. Two independent sessions built a project and a bank on 2026-09-19 and
// NEITHER ran git init, despite the doctrine's bootstrap step saying to do it immediately — the
// instruction had no reach, so the tool does it instead.
//
// Deliberately init-only, with no baseline commit: commit messages in these banks are hand-written
// and worth reading, and a tool that auto-commits every save would replace them with noise. The
// save response states the obligation instead. Best-effort throughout — a missing git binary or a
// failed init must never cost the note, which is the thing actually being asked for.
//
// A bank is always its OWN repo. A project bank sits inside the project (<project>/.pi/memory),
// and committing notes into the project's repo would put them in its history, and on GitHub with
// the next push. So a bank inside a repo gets a nested repo, and the enclosing repo ignores it
// through its local .git/info/exclude (never committed, so no project file changes).
export function initBankGit(dir: string): boolean {
  if (isOwnRepo(dir)) return false;
  const outer = git(dir, ["rev-parse", "--show-toplevel"]);
  if (git(dir, ["init", "-q"]) === null) return false;
  try {
    const ignore = path.join(dir, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, ".MEMORY.md.lock\n", "utf8");
    if (outer) {
      const exclude = path.resolve(outer, git(outer, ["rev-parse", "--git-path", "info/exclude"]) ?? ".git/info/exclude");
      const line = `/${path.relative(outer, dir).split(path.sep).join("/")}/`;
      const have = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
      if (!have.split(/\r?\n/).includes(line)) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.appendFileSync(exclude, `${have && !have.endsWith("\n") ? "\n" : ""}${line}\n`, "utf8");
      }
    }
  } catch {
    /* the repo exists; a missed ignore line only shows the bank as untracked in the project */
  }
  return true;
}

// True when dir is the top of its own repo, not a folder inside some other repo.
function isOwnRepo(dir: string): boolean {
  return git(dir, ["rev-parse", "--git-dir"]) === ".git";
}

// ── the write is the transaction, and the transaction is the broadcast ───────────────────────
// Until 2026-09-20 nothing on this path committed. The doctrine says "commit as you go" and
// "superseding a fact in place only has an undo if the prior value was committed" — but the
// instruction had no reach: this bank was found holding 4 uncommitted paths one morning and 66 two
// days earlier, so that undo did not exist for any of them.
//
// Committing here also buys the harder thing for free. The injected index is frozen per session on
// purpose (it keeps the prompt cache warm), so two sessions running at once cannot see each other's
// notes at all. On 2026-09-20 a session spent an hour on Codex cache behaviour while a sibling
// wrote `codex-prompt-cache-ceiling.md`; neither could have known. A commit feed is the cheapest
// channel that fixes it: one line per change, and the reader opens the note only if it touches
// their work — the same pointer-not-summary economics the index itself runs on.
function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return null;   // no git, no repo, nothing staged: all the same answer to the caller
  }
}

const reportedUpTo = new Map<string, string>();   // bank dir → the last commit this session was told about
const ourCommits = new Set<string>();             // what this session wrote: a sibling is everything else
const reportedDirty = new Map<string, string>();  // bank dir → the pending set we last mentioned

// Seeded at session start so the FIRST write of a session can still report what changed while it
// was thinking. Unseeded banks fall back to their pre-commit HEAD, which reports nothing rather
// than replaying the bank's whole history at someone.
export function markBankSeen(dir: string): void {
  if (reportedUpTo.has(dir)) return;
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (head) reportedUpTo.set(dir, head);
}

// ⛔ Path-scoped twice over. `git add -A` would sweep a concurrent session's in-flight edits into
// this commit — the one thing a shared bank must never do — and `-- <paths>` on the commit means
// even a change a sibling has already STAGED cannot ride along on ours.
export function commitWrite(dir: string, files: string[], subject: string): string | null {
  // ⛔ Never into an enclosing repo: that would be the project's history (see initBankGit).
  if (!isOwnRepo(dir)) return null;
  // initBankGit writes .gitignore and deliberately does not commit, so without this the very first
  // write leaves it untracked and EVERY later write reports a phantom "uncommitted path" from a
  // writer that does not exist. A feed that cries wolf once per write is a feed nobody reads.
  const paths = [...files];
  if (fs.existsSync(path.join(dir, ".gitignore"))) paths.push(".gitignore");
  if (git(dir, ["add", "--", ...paths]) === null) return null;
  // A fresh Git (e.g. Git for Windows straight from winget) has no identity and refuses to commit;
  // a configured identity always wins over this stand-in.
  const who = git(dir, ["config", "user.email"]) === null ? ["-c", "user.name=pi", "-c", "user.email=pi@localhost"] : [];
  if (git(dir, [...who, "commit", "-q", "-m", subject, "--", ...paths]) === null) return null;
  return git(dir, ["rev-parse", "HEAD"]);
}

const SIBLINGS_SHOWN = 5;

export function siblingChanges(dir: string): string {
  const out: string[] = [];
  const since = reportedUpTo.get(dir);
  if (since) {
    const log = git(dir, ["log", `--format=%H%x09%ar%x09%s`, `${since}..HEAD`]);
    const rows = (log ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .filter(([sha]) => !ourCommits.has(sha));
    for (const [, ago, subject] of rows.slice(0, SIBLINGS_SHOWN)) out.push(`  · ${subject} (${ago})`);
    if (rows.length > SIBLINGS_SHOWN) out.push(`  · …and ${rows.length - SIBLINGS_SHOWN} more`);
  }
  // A commit feed only sees writers that commit. Claude Code shares this bank, has no memory_write,
  // and edits by hand — so the log alone is blind to it. Status covers every writer regardless of
  // tooling: commits say what landed, status says what is still in flight.
  //
  // ⛔ Report a pending set ONCE, and again only when the set itself changes. A tester watched this
  // line repeat verbatim on consecutive writes with nothing about the file altered, and named the
  // cost exactly: a notice that repeats unchanged trains the reader to skip it, which spends the
  // one occasion it matters — the write where a SECOND uncommitted file appears.
  const status = git(dir, ["status", "--porcelain"]) ?? "";
  const dirty = status.split("\n").filter(Boolean);
  const signature = dirty.slice().sort().join("\n");
  if (dirty.length && reportedDirty.get(dir) !== signature) {
    out.push(`  · ${dirty.length} uncommitted path(s) — a writer that does not commit, likely Claude Code`);
  }
  reportedDirty.set(dir, signature);
  return out.length ? `\n\nChanged in this bank since your last write — open only what touches your work:\n${out.join("\n")}` : "";
}

// ⛔ Never fail a write because git failed. The note is already on disk; trading it for a commit
// would give up the thing actually asked for.
function commitAndBroadcast(dir: string, files: string[], subject: string): string {
  try {
    markBankSeen(dir);
    const sha = commitWrite(dir, files, subject);
    if (sha) ourCommits.add(sha);
    const report = siblingChanges(dir);
    const head = git(dir, ["rev-parse", "HEAD"]);
    if (head) reportedUpTo.set(dir, head);
    return `${sha ? " Committed." : ""}${report}`;
  } catch {
    return "";
  }
}

// The old rationale for not committing was that hand-written messages in this bank are worth
// reading — and they are. So the subject is the title and hook the author already wrote, not a
// generated summary of a diff.
export function commitSubject(verb: string, name: string, title?: string, hook?: string): string {
  const head = title && hook ? `${title} — ${hook}` : name;
  return `memory(${verb}): ${head}`.slice(0, 120);
}

// Claude Code and pi both append to one index with no shared locking. A stale lock is stolen after
// 10s so a crashed writer cannot wedge a bank permanently.
export async function withIndexLock<T>(dir: string, fn: () => T): Promise<T> {
  const lock = path.join(dir, ".MEMORY.md.lock");
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx");
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      try {
        return fn();
      } finally {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* already gone */
        }
      }
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock);
      } catch {
        /* raced */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`${indexIn(dir)} stayed locked for 2s — another writer may be wedged`);
}

function upsertIndexLine(dir: string, name: string, line: string): "replaced" | "appended" {
  const file = indexIn(dir);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = raw.split("\n");
  const target = `](${name}.md)`;
  const at = lines.findIndex((l) => l.trimStart().startsWith("- [") && l.includes(target));
  if (at >= 0) {
    lines[at] = line;
    writeAtomic(file, lines.join("\n"));
    return "replaced";
  }
  // Insert after the LAST existing entry, not at EOF: these indexes often close with a prose
  // paragraph (cini-gen's does), and appending past it produces a bullet stranded below the text.
  let lastEntry = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*- \[/.test(lines[i])) lastEntry = i;
  if (lastEntry >= 0) {
    lines.splice(lastEntry + 1, 0, line);
    writeAtomic(file, lines.join("\n"));
    return "appended";
  }
  writeAtomic(file, raw.trim() ? `${raw.replace(/\s*$/, "")}\n${line}\n` : `# Memory index\n\n${line}\n`);
  return "appended";
}

function dropIndexLine(dir: string, name: string): boolean {
  const file = indexIn(dir);
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const target = `](${name}.md)`;
  const kept = lines.filter((l) => !(l.trimStart().startsWith("- [") && l.includes(target)));
  if (kept.length === lines.length) return false;
  writeAtomic(file, kept.join("\n"));
  return true;
}

// ── the verifiable-claim fields ───────────────────────────────────────────────────────────────
// pi-bank-verify reads these; without them here the only write path was blind to the conventions
// it is supposed to produce, so every note needed a save followed by a hand edit — and that edit
// bypassed the lean gate and the index lock this tool exists to enforce.
type Extras = { host?: string; asserts?: any[]; sizeJustified?: string | boolean };

export function renderExtras(e: Extras): string[] {
  const out: string[] = [];
  if (e.host) out.push(`host: ${e.host}`);
  if (e.asserts?.length) {
    out.push("asserts:");
    for (const a of e.asserts) {
      const pairs = Object.entries(a).map(([k, v]) => `${k}: ${typeof v === "string" && /[:#,]/.test(v) ? JSON.stringify(v) : v}`);
      out.push(`  - ${pairs.join(", ")}`);
    }
  }
  // A size exemption that records nothing teaches nobody. Persisting it also makes this the SAME
  // fact pi-bank-lint honours, instead of a transient boolean that silently bypassed the gate.
  if (e.sizeJustified) out.push(`size_justified: ${typeof e.sizeJustified === "string" ? JSON.stringify(e.sizeJustified) : true}`);
  return out;
}

// `unit` and `cmd` were removed from the verifier: zero uses across every bank since they shipped,
// against five correctness bugs in the implementation. Rejecting them here rather than accepting
// and ignoring them means a write that would never have been checked fails loudly at the keystroke
// instead of looking stored and verified.
const ASSERT_SHAPES = ["path", "absent"];
const ASSERT_REMOVED = ["unit", "cmd"];

// ⛔ A relative assertion is an unanswerable one: `tests/__init__.py` resolves against whoever runs
// the check, so it passes at the write (the session's cwd IS the project) and is unverifiable in
// the daily sweep, which runs from somewhere else entirely. The same line then means two different
// things depending on who reads it.
//
// Found on 2026-09-19: a session recorded three relative asserts, every file existed, memory_write
// accepted all three without a word, and the sweep reported all three unchecked. Anchoring them to
// the writing session's cwd preserves exactly what the author meant — "this file, in this project"
// — and makes it true from anywhere. Reported in the response rather than done silently, because a
// tool that rewrites your input without saying so is its own problem.
export function absolutiseAsserts(asserts: any[] | undefined, cwd: string): string[] {
  if (!Array.isArray(asserts)) return [];
  const fixed: string[] = [];
  for (const a of asserts) {
    if (!a || typeof a !== "object") continue;
    for (const k of ASSERT_SHAPES) {
      const v = a[k];
      if (typeof v !== "string" || v.startsWith("/") || v.startsWith("~")) continue;
      a[k] = path.resolve(cwd, v);
      fixed.push(`${v} → ${a[k]}`);
    }
  }
  return fixed;
}

function anchoredNote(fixed: string[]): string {
  return fixed.length
    ? ` ⚠ Relative assertion${fixed.length > 1 ? "s" : ""} anchored to this directory so the sweep can check ${fixed.length > 1 ? "them" : "it"} from anywhere: ${fixed.join(", ")}.`
    : "";
}

// Reject a malformed assertion at the write, not three weeks later when a sweep calls it
// "unrecognised". The write is the only moment the author is present to fix it.
export function assertsIssue(asserts: any[] | undefined): string | undefined {
  if (!asserts) return undefined;
  if (!Array.isArray(asserts)) return "asserts must be a list.";
  for (const a of asserts) {
    if (!a || typeof a !== "object" || Array.isArray(a)) return `Each assertion must be an object, got ${JSON.stringify(a)}.`;
    const keys = Object.keys(a);
    const removed = keys.filter((k) => ASSERT_REMOVED.includes(k));
    if (removed.length) {
      return `Assertion key ${removed.join(", ")} was removed — nothing verifies it. State the fact in prose, or assert a path: or absent: that proves it.`;
    }
    if (!keys.some((k) => ASSERT_SHAPES.includes(k))) {
      return `Assertion ${JSON.stringify(a)} has no recognised key. Use one of: ${ASSERT_SHAPES.join(", ")}.`;
    }
    for (const k of ASSERT_SHAPES) if (a[k] !== undefined && typeof a[k] !== "string") return `${k} must be a string.`;
  }
  return undefined;
}

// Check the claims being stored, so a note cannot arrive already wrong. Only the EXPLICIT assertions
// are checked: re-implementing the prose extractor here would be a second mirror to keep in step,
// and the daily sweep covers prose. Never blocks the write — the author may be recording a fact
// about a machine that is asleep.
function verifyExtras(e: Extras): string[] {
  const bad: string[] = [];
  if (e.host && e.host !== os.hostname()) return bad;   // not this machine: unverifiable here
  for (const a of e.asserts ?? []) {
    const expand = (p: string) => (p.startsWith("~") ? os.homedir() + p.slice(1) : p);
    try {
      if (a.path && !/[*?]/.test(a.path) && !fs.existsSync(expand(a.path))) bad.push(`path ${a.path} does not exist`);
      if (a.absent && fs.existsSync(expand(a.absent))) bad.push(`absent: ${a.absent} still exists`);
    } catch {
      /* unreadable is not the author's problem at write time */
    }
  }
  return bad;
}

function frontmatter(name: string, description: string, type: string, extras: Extras = {}): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    ...renderExtras(extras),
    "metadata:",
    "  node_type: memory",
    `  type: ${type}`,
    "  origin: pi",
    `  modified: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
}

// Replace these keys in an existing block wherever they sit — Claude Code normalises frontmatter and
// moves custom keys inside `metadata:`, so matching only at column 0 would append a duplicate and
// make which one wins an accident of parser order.
export function mergeExtras(head: string, extras: Extras): string {
  const rendered = renderExtras(extras);
  if (!rendered.length) return head;
  let out = head;
  if (extras.host !== undefined) out = out.replace(/^[ \t]*host:.*$\n?/m, "");
  if (extras.sizeJustified !== undefined) out = out.replace(/^[ \t]*size_justified:.*$\n?/m, "");
  if (extras.asserts !== undefined) {
    // drop the whole block: its items are more-indented continuation lines
    out = out.replace(/^([ \t]*)asserts:[ \t]*$\n(?:\1[ \t]+.*$\n?)*/m, "");
  }
  const close = out.lastIndexOf("\n---");
  return close < 0 ? out : `${out.slice(0, close)}\n${rendered.join("\n")}${out.slice(close)}`;
}

const STALE_NOTE =
  "This session's injected index is unchanged by design (freezing it keeps the prompt cache warm); the bank on disk is what counts.";

// Local addition 2026-08-25: write-time lean gate. The 2026-08-25 bank thinning cut 55% of the
// bank's bytes — nearly all narrative written mid-session — so the standard is enforced at the only
// point that scales: the write. A new body over ~4000 chars is a consolidation, not a fact; a hook
// over 160 chars taxes every session's cached prefix. Updates may grow 1.5×, but bounded both ways
// (2026-08-29): a floor of 4000 so a small memory absorbing new knowledge is never more restricted
// than a fresh save, and a ceiling of 8000 so repeated 1.5× growth cannot compound past it without
// sizeJustified (the ratchet that let files drift to 12K+). Shrinking updates always pass — never
// punish thinning.
// Local addition 2026-09-12: the targets stay, but they are no longer a cliff. A 14-day audit of
// 244 memory_write calls found 16 rejections and almost all were MARGINAL: bodies of 4026 and 4038
// against the 4000 target (0.7% over), hooks of 170-185 against 160. A model cannot count characters,
// so each of those cost a whole round-trip to delete one sentence. Reject only past a ~12% band and
// nudge inside it. The absolute 8000 ceiling is deliberately NOT widened — it is the anti-ratchet
// guard that stopped files drifting to 12K+, so the band is clamped by it.
const HOOK_TARGET = 160;
const HOOK_MAX = 200;
const BODY_BAND = 1.125;

function bodyCapFor(action: "save" | "update", existingBodyLen: number): number {
  return action === "update" ? Math.min(8000, Math.max(4000, Math.floor(existingBodyLen * 1.5))) : 4000;
}

// Accepted-but-over-target: say so on the way out so the band cannot quietly become the new target.
export function leanGateNudge(
  action: "save" | "update",
  bodyLen: number,
  hookLen: number,
  existingBodyLen = 0,
): string {
  const over: string[] = [];
  if (hookLen > HOOK_TARGET) over.push(`hook ${hookLen} (target ${HOOK_TARGET})`);
  const cap = bodyCapFor(action, existingBodyLen);
  const shrinking = action === "update" && bodyLen <= existingBodyLen;
  if (bodyLen > cap && !shrinking) over.push(`body ${bodyLen} (target ${cap})`);
  return over.length ? ` ⚠ Over target: ${over.join(", ")} — trim on the next edit.` : "";
}

// ── hygiene: what is being stored, not how big it is ──────────────────────────────────────────
// A keyword followed by an environment lookup (`secret = process.env.JWT_SECRET`) names where a
// secret lives, which is exactly what a note should say; a generic match needs a digit, as every
// random key of 16+ characters has (found 2026-10-17: three such lines were flagged in a real bank).
// A credential is the one content error worse than a missing note: the bank is plain text in git,
// mirrored into prompts and shared with other agents. Refused outright and never staged, because a
// draft is a file on disk too; the error masks the match so the refusal does not echo it either.
const SECRET =
  /\b(sk-(?:ant-|live-|proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:private_?key|preshared_?key)["']?\s*[:=]\s*["']?[A-Za-z0-9+/]{42,}={0,2})|(?:password|passwd|api[_-]?key|secret|token|bearer)["']?\s*[:=]\s*["']?(?![<{$]|process\.env|os\.environ|import\.meta)(?=[A-Za-z0-9/+_.-]*\d)[A-Za-z0-9/+_.-]{16,}/i;

export function secretIssue(texts: unknown[]): string | undefined {
  for (const t of texts) {
    if (typeof t !== "string") continue;
    const m = SECRET.exec(t);
    if (m) {
      const hit = m[0];
      return `Refused: this write contains what looks like a credential (${hit.slice(0, 6)}…${hit.length > 12 ? hit.slice(-2) : ""}). A memory must never hold a secret value — record where it lives instead (a file and key name, e.g. ".env, STAGING_API_KEY", or the secret manager entry). Nothing was written or staged.`;
    }
  }
  return undefined;
}

const RELATIVE = /\b(today|tonight|yesterday|tomorrow|this (?:morning|afternoon|evening|week|month)|last (?:night|week|month)|next (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|a few days ago|the other day)\b/gi;
const STORY = /\b(I tried|I then|then I|first I|we tried|we then|then we|after (?:some|much|a lot of) (?:digging|investigation|debugging)|it turned out|turns out)\b/i;
const localDate = () => new Date().toLocaleDateString("sv-SE");

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 3 && !HYGIENE_STOP.has(w))
      .map((w) => (w.length > 4 ? w.replace(/s$/, "") : w)),   // "timeouts" meets "timeout"
  );
const HYGIENE_STOP = new Set("with that this from what when which about into only have than they them their there were will your more does also note notes memory memories project machine reference feedback user".split(" "));

/** Index entries of a bank whose subject overlaps this write's, best first. */
function similarNotes(dir: string, name: string, subject: string): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(indexIn(dir), "utf8");
  } catch {
    return [];
  }
  const mine = words(`${name.replace(/[-_]/g, " ")} ${subject}`);
  if (mine.size < 2) return [];
  const hits: [number, string][] = [];
  for (const line of raw.split("\n")) {
    const m = /^\s*- \[(.*?)\]\(([^)]+)\.md\)\s*(?:[—–-]\s*)?(.*)$/.exec(line);
    if (!m || m[2] === name) continue;
    const theirs = words(`${m[2].replace(/[-_]/g, " ")} ${m[1]} ${m[3]}`);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    const score = shared / Math.min(mine.size, theirs.size || 1);
    if (shared >= 2 && score >= 0.4) hits.push([score, `${m[2]}.md ("${m[1]}")`]);
  }
  return hits.sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, s]) => s);
}

// A bank whose notes are named `<type>_name` should not gain a stray `name` beside them: the index is
// read by eye, and a name that breaks the bank's pattern is where duplicates hide.
function namingHint(dir: string, name: string, type: string | undefined): string | undefined {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && f !== `${name}.md`).map((f) => f.slice(0, -3));
  } catch {
    return undefined;
  }
  const typed = /^(user|feedback|project|reference)_/;
  const typedBank = names.length >= 3 && names.filter((n) => typed.test(n)).length / names.length >= 0.6;
  if (typedBank && type && !typed.test(name)) {
    return `this bank names notes <type>_name: rename it with memory_write rename newName:"${type}_${name.replace(/-/g, "_")}"`;
  }
  if (name.includes("-") && name.includes("_")) {
    return `the name mixes - and _: rename it to ${typedBank ? name.replace(/-/g, "_") : name.replace(/_/g, "-")}`;
  }
  return undefined;
}

/** Non-blocking findings about the content just written, each with its fix. */
export function hygieneNotes(dir: string, name: string, body: string, subject: string, isSave: boolean, type?: string): string[] {
  const out: string[] = [];
  if (isSave) {
    const hint = namingHint(dir, name, type);
    if (hint) out.push(hint);
  }
  const rel = [...new Set((body.match(RELATIVE) ?? []).map((w) => w.toLowerCase()))];
  if (rel.length) out.push(`relative date${rel.length > 1 ? "s" : ""} ${rel.map((w) => `"${w}"`).join(", ")}: the note outlives ${rel.length > 1 ? "them" : "it"} — replace with dates (today is ${localDate()}) via edit`);
  if (STORY.test(body)) out.push("it reads like the story of the session: state the final fact, and a dead end as what is NOT the cause, via edit");
  const dangling = [...new Set([...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]))].filter(
    (l) => !fs.existsSync(path.join(dir, `${l}.md`)) && !fs.existsSync(path.join(HOME_BANK, `${l}.md`)),
  );
  if (dangling.length) out.push(`[[${dangling.join("]], [[")}]] point${dangling.length > 1 ? "" : "s"} at no note in this bank or the machine bank`);
  if (isSave) {
    const near = [...similarNotes(dir, name, subject), ...(dir !== HOME_BANK ? similarNotes(HOME_BANK, name, subject).map((s) => `machine bank ${s}`) : [])];
    if (near.length) out.push(`similar note${near.length > 1 ? "s" : ""} already exist: ${near.join(", ")} — if it is the same subject, fold this into that note (edit or append) and remove this one`);
  }
  return out;
}

// ── drafts: a refused write is staged, so the fix carries only the change ─────────────────────
// Measured 2026-10-17 over two machines' transcripts: 85 refused writes, and every retry re-sent the
// whole note — ~270K characters, mostly unchanged (a missing **Why:** line: 86% of lines identical;
// a long hook: 94%). Size refusals were worse: the retry shared 4-18% of its lines with the refused
// body, i.e. the model rewrote the note from memory and cut 25-35% to be safe, losing facts to get
// under a limit by a few hundred characters. The limits were never the cost; discarding the payload
// was. So a write that fails a content check is kept here, the error names the exact shortfall, and
// `draft: true` applies just the delta (edits, a hook, a why line) and finishes the original write.
const DRAFT_DIR = path.join(os.homedir(), ".pi", "agent", "memory-bank-drafts");
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Meta = { title?: string; hook?: string; description?: string; type?: string; host?: string; asserts?: any[]; sizeJustified?: string | boolean };
type Draft =
  | { kind: "save"; dir: string; name: string; body: string; meta: Meta; staged: number }
  | { kind: "update"; dir: string; name: string; body: string; meta: Meta; baseHash: string; staged: number };

function draftFile(dir: string, name: string): string {
  return path.join(DRAFT_DIR, `${crypto.createHash("sha1").update(dir).digest("hex").slice(0, 12)}-${name}.json`);
}
function loadDraft(dir: string, name: string): Draft | null {
  try {
    const d = JSON.parse(fs.readFileSync(draftFile(dir, name), "utf8"));
    return d?.dir === dir && d?.name === name && Date.now() - d.staged < DRAFT_TTL_MS ? d : null;
  } catch {
    return null;
  }
}
function dropDraft(dir: string, name: string): void {
  fs.rmSync(draftFile(dir, name), { force: true });
}
function stageDraft(d: Draft): void {
  fs.mkdirSync(DRAFT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(draftFile(d.dir, d.name), JSON.stringify(d), { mode: 0o600 });
}
export function pruneDrafts(): void {
  try {
    for (const f of fs.readdirSync(DRAFT_DIR)) {
      const p = path.join(DRAFT_DIR, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > DRAFT_TTL_MS) fs.unlinkSync(p);
      } catch {
        /* raced */
      }
    }
  } catch {
    /* no drafts yet */
  }
}

const hashOf = (text: string) => crypto.createHash("sha1").update(text).digest("hex");

/** Frontmatter block (through its closing ---) and body, or null when there is no block. */
export function splitNote(text: string): { head: string; body: string } | null {
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  return end < 0 ? null : { head: text.slice(0, end + 4), body: text.slice(end + 4).trim() };
}

/** The title and hook of a note's index line, in this bank's `- [Title](name.md) — hook` form. */
function readIndexEntry(dir: string, name: string): { title: string; hook: string } | null {
  let raw = "";
  try {
    raw = fs.readFileSync(indexIn(dir), "utf8");
  } catch {
    return null;
  }
  const line = raw.split("\n").find((l) => l.trimStart().startsWith("- [") && l.includes(`](${name}.md)`));
  const m = line && /^\s*- \[(.*?)\]\([^)]*\)\s*(?:[—–-]\s*)?(.*)$/.exec(line);
  return m ? { title: m[1], hook: m[2].trim() } : null;
}

/** Replace a frontmatter key wherever it sits (Claude Code moves keys under metadata:), or add it. */
export function setFrontmatterField(head: string, key: string, value: string): string {
  const re = new RegExp(`^([ \\t]*)${key}:.*$`, "m");
  if (re.test(head)) return head.replace(re, (_m, indent) => `${indent}${key}: ${value}`);
  const close = head.lastIndexOf("\n---");
  return `${head.slice(0, close)}\n${key}: ${value}${head.slice(close)}`;
}

/** Edits apply in order; each oldText must match exactly once, or nothing is applied. */
export function applyEdits(body: string, edits: any): { body: string } | { error: string } {
  if (!Array.isArray(edits) || !edits.length) return { error: "edits must be a non-empty list of {oldText, newText}." };
  let out = body;
  for (const [i, e] of edits.entries()) {
    if (typeof e?.oldText !== "string" || !e.oldText || typeof e?.newText !== "string") return { error: `edits[${i}] needs a non-empty oldText and a newText string.` };
    const at = out.indexOf(e.oldText);
    if (at < 0) return { error: `edits[${i}].oldText was not found in the body; nothing was applied. Quote the body exactly.` };
    if (out.indexOf(e.oldText, at + 1) >= 0) return { error: `edits[${i}].oldText occurs more than once; nothing was applied. Add surrounding text to make it unique.` };
    out = out.slice(0, at) + e.newText + out.slice(at + e.oldText.length);
  }
  return { body: out.trim() };
}

const hasWhy = (body: string) => /\*\*Why:?\*\*/i.test(body);
function withWhy(body: string, why: unknown): string {
  return typeof why === "string" && why.trim() && !hasWhy(body) ? `**Why:** ${oneLine(why)}\n\n${body}` : body;
}

/** What blocks this write, each with its exact fix. The numbers are bodyCapFor's and the band's above. */
export function contentIssues(kind: "save" | "update", body: string, meta: Meta, hookGiven: boolean, existingBodyLen: number): string[] {
  const issues: string[] = [];
  const hookLen = hookGiven ? oneLine(meta.hook ?? "").length : 0;
  if (hookLen > HOOK_MAX) issues.push(`hook is ${hookLen} chars, limit ${HOOK_MAX}: send hook:"…" under ${HOOK_TARGET} (it rides in every session's prefix)`);
  const shrinking = kind === "update" && body.length <= existingBodyLen;
  if (!meta.sizeJustified && !shrinking) {
    const cap = bodyCapFor(kind, existingBodyLen);
    const hard = Math.min(8000, Math.floor(cap * BODY_BAND));
    if (body.length > hard) {
      issues.push(
        `body is ${body.length} chars, limit ${hard} for this note: cut at least ${body.length - hard} (aim under ${cap}) with edits:[{oldText:"<exact text>", newText:""}] — cut narrative, superseded attempts and what another note already says ([[link]] it). Only when every remaining fact is needed together, pass sizeJustified:"<reason>" instead; an unthinned note never qualifies`,
      );
    }
  }
  if (kind === "save" && (meta.type === "feedback" || meta.type === "project") && !hasWhy(body)) {
    issues.push(`a ${meta.type} note leads with its reason: send why:"<one line>"${meta.type === "feedback" ? ' (and add "**How to apply:**" via edits if it is missing)' : ""}`);
  }
  return issues;
}

function staged(d: Draft, scope: string | undefined, issues: string[]) {
  stageDraft(d);
  const call = `memory_write({action:"${d.kind}", name:"${d.name}"${scope === "machine" ? ', scope:"machine"' : ""}, draft:true, …only the fix…})`;
  return fail(`Not written yet — staged as a draft, nothing lost. Fix:\n- ${issues.join("\n- ")}\nSend only the fix: ${call}. Fields you pass replace the draft's; edits apply to its body. The draft is kept 7 days.`);
}

type Ctx = { dir: string; where: string; name: string; file: string; scope?: string };

async function finishSave(c: Ctx, body: string, meta: Meta, hookGiven: boolean) {
  // Saving over a note would lose it: the one refusal no draft can fix.
  if (fs.lstatSync(c.file, { throwIfNoEntry: false })) {
    const head = fs.existsSync(c.file) ? fs.readFileSync(c.file, "utf8").split("\n").slice(0, 12).join("\n") : "(a dangling symlink)";
    return fail(`"${c.name}" already exists in ${c.where} — update it instead (edit/append send only the change). Current head:\n\n${head}`);
  }
  const issues = contentIssues("save", body, meta, hookGiven, 0);
  if (issues.length) return staged({ kind: "save", dir: c.dir, name: c.name, body, meta, staged: Date.now() }, c.scope, issues);
  const title = oneLine(meta.title ?? "", true);
  const hook = oneLine(meta.hook ?? "");
  const extras: Extras = { host: meta.host, asserts: meta.asserts, sizeJustified: meta.sizeJustified };
  const anchored = absolutiseAsserts(extras.asserts, process.cwd());
  // With both separators legal, "project-x" beside "project_x" is probably one memory under two names.
  const twin = fs.existsSync(c.dir)
    ? fs.readdirSync(c.dir).find((f) => f !== `${c.name}.md` && f.replace(/_/g, "-") === `${c.name.replace(/_/g, "-")}.md`)
    : undefined;
  const freshBank = !fs.existsSync(c.dir);
  fs.mkdirSync(c.dir, { recursive: true });
  const inited = freshBank ? initBankGit(c.dir) : false;
  writeAtomic(c.file, `${frontmatter(c.name, meta.description ?? "", meta.type ?? "", extras)}\n${body}\n`);
  dropDraft(c.dir, c.name);
  let broadcast = "";
  const what = await withIndexLock(c.dir, () => {
    const w = upsertIndexLine(c.dir, c.name, `- [${title}](${c.name}.md) — ${hook}`);
    broadcast = commitAndBroadcast(c.dir, [`${c.name}.md`, "MEMORY.md"], commitSubject("save", c.name, title, hook));
    return w;
  });
  const wrong = verifyExtras(extras);
  const warn = wrong.length ? ` ⚠ Stored, but already untrue on this machine: ${wrong.join("; ")}. Fix the claim or the machine.` : "";
  const twinNote = twin ? ` ⚠ ${twin} differs from this name only by - versus _: if it is the same subject, merge them.` : "";
  const hygiene = hygieneNotes(c.dir, c.name, body, `${title} ${hook} ${meta.description ?? ""}`, true, meta.type);
  const hygieneNote = hygiene.length ? ` ⚠ Hygiene: ${hygiene.join("; ")}.` : "";
  const gitNote = inited ? " Initialised git in this new bank, so superseding a fact in place has an undo; writes here are committed for you from now on." : "";
  // A justified body was exempted on purpose; nudging it to trim would contradict the exemption.
  const nudge = leanGateNudge("save", meta.sizeJustified ? 0 : body.length, hook.length);
  return ok(`Saved ${c.name}.md in ${c.where} and ${what} its index line.${warn}${twinNote}${hygieneNote}${gitNote}${anchoredNote(anchored)} ${STALE_NOTE}${nudge}${broadcast}`);
}

/** Every change to an existing note lands here: a new body (whole, edited or appended) and/or metadata. */
async function finishUpdate(c: Ctx, body: string | undefined, meta: Meta, hookGiven: boolean, verb: string, baseHash?: string, added?: string, removed?: string[]) {
  const link = fs.lstatSync(c.file).isSymbolicLink();
  if (link && !fs.existsSync(c.file)) return fail(`${c.name}.md is a link to ${fs.readlinkSync(c.file)}, which does not exist.`);
  // A shared note is a symlink into another repo: write its target, so the link survives.
  const target = link ? fs.realpathSync(c.file) : c.file;
  const existing = fs.readFileSync(target, "utf8");
  if (baseHash && hashOf(existing) !== baseHash) {
    dropDraft(c.dir, c.name);
    return fail(`${c.name}.md changed since this draft was staged, so finishing it would overwrite that change. The draft is dropped: read the note again and redo the edit.`);
  }
  const parts = splitNote(existing);
  if (!parts) return fail(`${c.name}.md has no frontmatter block — edit it by hand rather than through this tool.`);
  const newBody = body ?? parts.body;
  const issues = contentIssues("update", newBody, meta, hookGiven, parts.body.length);
  if (issues.length) {
    return staged({ kind: "update", dir: c.dir, name: c.name, body: newBody, meta, baseHash: hashOf(existing), staged: Date.now() }, c.scope, issues);
  }
  const extras: Extras = { host: meta.host, asserts: meta.asserts, sizeJustified: meta.sizeJustified };
  const anchored = absolutiseAsserts(extras.asserts, process.cwd());
  let head = parts.head;
  if (meta.description !== undefined) head = setFrontmatterField(head, "description", JSON.stringify(meta.description.trim()));
  if (meta.type !== undefined) head = setFrontmatterField(head, "type", meta.type);
  // Keep the author's frontmatter, but bump the stamp: a body that changed while its date did not
  // reads as older than it is.
  head = mergeExtras(head.replace(/^(\s*modified:).*$/m, `$1 ${new Date().toISOString()}`), extras);
  writeAtomic(target, `${head}\n\n${newBody}\n`);
  dropDraft(c.dir, c.name);
  let note = "";
  let broadcast = "";
  const known = readIndexEntry(c.dir, c.name);
  const title = meta.title !== undefined ? oneLine(meta.title, true) : known?.title;
  const hook = meta.hook !== undefined ? oneLine(meta.hook) : known?.hook;
  // The commit happens whether or not the index line moved: the body changed either way, and an
  // uncommitted body is a fact with no undo.
  await withIndexLock(c.dir, () => {
    if ((meta.title !== undefined || meta.hook !== undefined) && title && hook) {
      note = ` Index line ${upsertIndexLine(c.dir, c.name, `- [${title}](${c.name}.md) — ${hook}`)}.`;
    } else if (meta.title !== undefined || meta.hook !== undefined) {
      note = " ⚠ The index line was not changed: it has no entry yet, so pass both title and hook.";
    }
    broadcast = commitAndBroadcast(c.dir, [`${c.name}.md`, "MEMORY.md"], commitSubject(verb, c.name, title, hook));
  });
  let shared = "";
  if (link) {
    const repo = git(path.dirname(target), ["rev-parse", "--show-toplevel"]);
    shared = ` This note is a link to ${target}: the change was written there and is uncommitted${repo ? ` in ${repo}` : ""} — commit it in that repo.`;
  }
  const wrong = verifyExtras(extras);
  const warn = wrong.length ? ` ⚠ Stored, but already untrue on this machine: ${wrong.join("; ")}. Fix the claim or the machine.` : "";
  const nudge = leanGateNudge("update", meta.sizeJustified ? 0 : newBody.length, (meta.hook ?? "").length, parts.body.length);
  // Only what this write added is checked: a warning about an old sentence would repeat on every edit.
  const hygiene = body === undefined ? [] : hygieneNotes(c.dir, c.name, added ?? newBody, "", false);
  // Text that shares no word with the note's own subject was probably filed in the wrong note
  // (measured 2026-10-17: a test-scope preference appended to an unrelated "small diffs" note).
  // An oldText wider than the change silently drops the lines its newText does not restate
  // (measured 2026-10-17: a start-up instruction lost that way). Name them, so a loss is a choice.
  // A rewritten line keeps its specifics (code, numbers, paths); a dropped one loses them.
  const specifics = (l: string) => [...l.matchAll(/`([^`]+)`|\b\d{2,}[\w.%]*|[\w.-]+\/[\w./-]+/g)].map((m) => m[1] ?? m[0]);
  const bodyWords = words(newBody);
  // A whole-body update is checked against the body it replaces; a staged draft's cuts are intended.
  const before = removed ?? (verb === "update" && body !== undefined && !baseHash ? parts.body.split("\n").map((l) => l.trim()).filter((l) => l.length > 3) : []);
  const dropped = before.filter((l) => {
    if (newBody.includes(l)) return false;
    const t = specifics(l);
    if (t.length) return t.some((x) => !newBody.includes(x));
    const w = [...words(l)];
    return w.length >= 2 && w.filter((x) => !bodyWords.has(x)).length / w.length > 0.5;
  });
  if (dropped.length) {
    hygiene.push(`this write removed ${dropped.length} line${dropped.length > 1 ? "s" : ""} it did not restate: ${dropped.slice(0, 3).map((l) => `"${l.slice(0, 60)}${l.length > 60 ? "…" : ""}"`).join(", ")} — if that was not intended, append it back`);
  }
  if (added && added.length > 60) {
    const known = readIndexEntry(c.dir, c.name);
    const subject = words(`${c.name.replace(/[-_]/g, " ")} ${known?.title ?? ""} ${known?.hook ?? ""} ${/^\s*description:(.*)$/m.exec(parts.head)?.[1] ?? ""}`);
    if (subject.size >= 2 && ![...words(added)].some((w) => subject.has(w))) {
      hygiene.push(`what you added shares no word with this note's subject (${c.name}): if it is a different subject, give it its own note`);
    }
  }
  const hygieneNote = hygiene.length ? ` ⚠ Hygiene: ${hygiene.join("; ")}.` : "";
  return ok(`Updated ${c.name}.md in ${c.where} (${body === undefined ? "metadata only" : `${verb === "update" ? "body replaced" : verb === "edit" ? "body edited" : "appended"}, ${newBody.length} chars`}).${note}${shared}${warn}${hygieneNote}${anchoredNote(anchored)} ${STALE_NOTE}${nudge}${broadcast}`);
}

const META_KEYS = ["title", "hook", "description", "type", "host", "asserts", "sizeJustified"] as const;
function metaOf(params: any): Meta {
  const m: any = {};
  for (const k of META_KEYS) if (params?.[k] !== undefined) m[k] = params[k];
  return m;
}

/** Rewrite `[[from]]` to `[[to]]` in the bank's own notes; shared (linked) notes are only reported. */
function relink(dir: string, from: string, to: string): { files: string[]; shared: string[] } {
  const files: string[] = [];
  const shared: string[] = [];
  const re = new RegExp(`\\[\\[${from}\\]\\]`, "g");   // slugs carry no regex metacharacters
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "MEMORY.md") continue;
    const p = path.join(dir, f);
    const text = fs.readFileSync(p, "utf8");
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    if (fs.lstatSync(p).isSymbolicLink()) shared.push(f);
    else {
      writeAtomic(p, text.replace(re, `[[${to}]]`));
      files.push(f);
    }
  }
  return { files, shared };
}

/** Point a note's index line at its new file, in place, keeping its title, hook and position. */
function renameIndexLine(dir: string, from: string, to: string): void {
  const file = indexIn(dir);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith("- [") && l.includes(`](${from}.md)`));
  if (at < 0) return;
  lines[at] = lines[at].replace(`](${from}.md)`, `](${to}.md)`);
  writeAtomic(file, lines.join("\n"));
}

function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err: any) {
    // Banks normally share a filesystem with each other and the trash; another one makes rename EXDEV.
    if (err?.code !== "EXDEV") throw err;
    if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

async function runWrite(params: any, cwd: string) {
  const resolved = resolveBank(cwd);
  const scope: string | undefined = params?.scope;
  const dir = scope === "machine" ? HOME_BANK : resolved.dir;
  const where = dir === resolved.dir ? dir : `${dir} (machine-wide)`;
  const action: string = params?.action;
  const name: string = (params?.name ?? "").trim();
  const file = memoryFile(dir, name);
  if (!file) return fail(`Invalid name "${name}". Use a lowercase slug like "gpu-fan-curve" or "project_gpu_fan" (letters, digits, - or _; max 100 chars, not "MEMORY").`);
  const c: Ctx = { dir, where, name, file, scope };
  const secret = secretIssue([params?.body, params?.text, params?.why, params?.title, params?.hook, params?.description, ...(Array.isArray(params?.edits) ? params.edits.map((e: any) => e?.newText) : [])]);
  if (secret) return fail(secret);
  const exists = Boolean(fs.lstatSync(file, { throwIfNoEntry: false }));
  const meta = metaOf(params);
  if (meta.type !== undefined && !(MEMORY_TYPES as readonly string[]).includes(meta.type)) return fail(`type must be one of ${MEMORY_TYPES.join(", ")}.`);
  const shape = assertsIssue(meta.asserts);
  if (shape) return fail(shape);

  // Finish a staged write with only the change: passed fields replace the draft's, edits and why
  // apply to its body.
  if (params?.draft === true) {
    const d = loadDraft(dir, name);
    if (!d) return fail(`No staged draft for "${name}" in ${where} (drafts are kept 7 days). Send the write in full.`);
    let body = typeof params?.body === "string" ? params.body.trim() : d.body;
    if (params?.edits !== undefined) {
      const r = applyEdits(body, params.edits);
      if ("error" in r) return fail(`${r.error} The draft is unchanged.`);
      body = r.body;
    }
    if (typeof params?.text === "string" && params.text.trim()) body = `${body}\n\n${params.text.trim()}`;
    body = withWhy(body, params?.why);
    const merged = { ...d.meta, ...meta };
    const hookGiven = merged.hook !== undefined;
    if (d.kind === "save") return finishSave(c, body, merged, hookGiven);
    if (!exists) {
      dropDraft(dir, name);
      return fail(`${name}.md no longer exists in ${where}; the draft is dropped. Save it as a new note.`);
    }
    return finishUpdate(c, body, merged, hookGiven, "update", d.baseHash);
  }

  if (action === "remove") {
    if (!exists) return fail(`No memory named "${name}" in ${where} — nothing removed.`);
    const link = fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : null;
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const dest = path.join(TRASH_DIR, `${name}-${Date.now()}.md`);
    // A shared note's link is what moves to the trash; its target in the other repo is untouched.
    moveFile(file, dest);
    dropDraft(dir, name);
    let broadcast = "";
    const dropped = await withIndexLock(dir, () => {
      const d = dropIndexLine(dir, name);
      broadcast = commitAndBroadcast(dir, [`${name}.md`, "MEMORY.md"], commitSubject("retire", name));
      return d;
    });
    return ok(
      `Removed "${name}" from ${where} (recoverable at ${dest})${dropped ? " and dropped its index line" : " — it had no index line"}.${link ? ` It was a link: its target ${link} is untouched.` : ""} ${STALE_NOTE}${broadcast}`,
    );
  }

  if (action === "rename" || action === "move") {
    if (!exists) return fail(`No memory named "${name}" in ${where}.`);
    const toName: string = action === "rename" ? String(params?.newName ?? "").trim() : name;
    const toScope = action === "move" ? params?.to : scope;
    if (action === "move" && toScope !== "here" && toScope !== "machine") return fail(`move needs to: "here" or "machine".`);
    const toDir = toScope === "machine" ? HOME_BANK : resolved.dir;
    if (action === "move" && toDir === dir) return fail(`"${name}" is already in ${where}.`);
    const toFile = memoryFile(toDir, toName);
    if (!toFile) return fail(`Invalid newName "${toName}". Use a lowercase slug (letters, digits, - or _).`);
    if (toFile === file) return fail(`"${name}" already has that name.`);
    if (fs.lstatSync(toFile, { throwIfNoEntry: false })) return fail(`${toName}.md already exists in ${toDir}; ${action} would overwrite it. Merge the two notes instead.`);
    const entry = readIndexEntry(dir, name);
    const link = fs.lstatSync(file).isSymbolicLink();
    if (!fs.existsSync(toDir)) {
      fs.mkdirSync(toDir, { recursive: true });
      initBankGit(toDir);
    }
    moveFile(file, toFile);
    // The note's own name: field follows it, except through a link, whose target another repo owns.
    if (!link && toName !== name) {
      const text = fs.readFileSync(toFile, "utf8");
      const parts = splitNote(text);
      if (parts) writeAtomic(toFile, `${setFrontmatterField(parts.head, "name", toName)}\n\n${parts.body}\n`);
    }
    dropDraft(dir, name);
    const line = entry ? `- [${entry.title}](${toName}.md) — ${entry.hook}` : null;
    let report = "";
    if (action === "rename") {
      let relinked: { files: string[]; shared: string[] } = { files: [], shared: [] };
      let broadcast = "";
      await withIndexLock(dir, () => {
        if (line) renameIndexLine(dir, name, toName);
        relinked = relink(dir, name, toName);
        broadcast = commitAndBroadcast(dir, [`${name}.md`, `${toName}.md`, "MEMORY.md", ...relinked.files], commitSubject("rename", toName, entry?.title, entry?.hook));
      });
      report = `${relinked.files.length ? ` Rewrote [[${name}]] → [[${toName}]] in ${relinked.files.join(", ")}.` : ""}${relinked.shared.length ? ` ⚠ Shared notes still link [[${name}]]: ${relinked.shared.join(", ")} — edit them at their target.` : ""}${broadcast}`;
      return ok(`Renamed ${name}.md → ${toName}.md in ${where}${line ? ", index line moved" : " (it had no index line)"}.${report} ${STALE_NOTE}`);
    }
    let b1 = "";
    let b2 = "";
    await withIndexLock(dir, () => {
      dropIndexLine(dir, name);
      b1 = commitAndBroadcast(dir, [`${name}.md`, "MEMORY.md"], commitSubject("move-out", name, entry?.title, entry?.hook));
    });
    await withIndexLock(toDir, () => {
      if (line) upsertIndexLine(toDir, name, line);
      b2 = commitAndBroadcast(toDir, [`${name}.md`, "MEMORY.md"], commitSubject("move-in", name, entry?.title, entry?.hook));
    });
    const linkers = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && fs.readFileSync(path.join(dir, f), "utf8").includes(`[[${name}]]`));
    // A project note may link into the machine bank; the machine bank linking a project note dangles.
    const dangling = toScope === "here" && linkers.length ? ` ⚠ Machine-bank notes link [[${name}]] and will no longer resolve: ${linkers.join(", ")}.` : "";
    return ok(`Moved ${name}.md from ${dir} to ${toDir}${line ? " with its index line" : " (it had no index line)"}.${dangling} ${STALE_NOTE}${b1}${b2}`);
  }

  if (action === "edit" || action === "append") {
    if (!exists) return fail(`No memory named "${name}" in ${where}. Use action "save" to create it.`);
    const current = splitNote(fs.readFileSync(file, "utf8"));
    if (!current) return fail(`${name}.md has no frontmatter block — edit it by hand rather than through this tool.`);
    let body = current.body;
    let added: string;
    let removed: string[] = [];
    if (action === "edit") {
      const r = applyEdits(body, params?.edits);
      if ("error" in r) return fail(r.error);
      body = r.body;
      added = params.edits.map((e: any) => e.newText).join("\n");
      removed = params.edits.flatMap((e: any) => String(e.oldText).split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 3));
    } else {
      const text = typeof params?.text === "string" ? params.text.trim() : "";
      if (!text) return fail("append needs text: the markdown to add at the end of the body.");
      body = `${body}\n\n${text}`;
      added = text;
    }
    return finishUpdate(c, body, meta, meta.hook !== undefined, action, undefined, added, removed);
  }

  const bodyParam = typeof params?.body === "string" && params.body.trim() ? params.body.trim() : undefined;

  if (action === "update") {
    if (!exists) {
      // An update of a note that does not exist yet, carrying everything a save needs, is a save.
      if (bodyParam && meta.title && meta.hook && meta.description && meta.type) return finishSave(c, withWhy(bodyParam, params?.why), meta, true);
      return fail(`No memory named "${name}" in ${where}. Use action "save" to create it (title, hook, description, type and body).`);
    }
    if (bodyParam === undefined && !Object.keys(meta).length) {
      return fail("update needs a body, or one of title, hook, description, type, host, asserts, sizeJustified. For a partial body change use edit or append.");
    }
    return finishUpdate(c, bodyParam === undefined ? undefined : withWhy(bodyParam, params?.why), meta, meta.hook !== undefined, "update");
  }

  if (action !== "save") return fail(`Unknown action "${action}".`);
  if (!bodyParam || !meta.title || !meta.hook || !meta.description || !meta.type) {
    return fail("save requires title, hook, description, type and body.");
  }
  if (exists) return finishSave(c, bodyParam, meta, true);   // refuses with the current head
  return finishSave(c, withWhy(bodyParam, params?.why), meta, true);
}

export default function (pi: ExtensionAPI) {
  // Take the snapshot before the first request rather than during it, so turn one is not the read.
  pi.on("session_start", async (_event: any, ctx: any) => {
    if (!ENABLED) return;
    prune();
    pruneDrafts();
    const snap = snapshotFor(ctx);
    // Watermark every bank this session can see, so the first write already knows what landed
    // while the session was working rather than starting its feed from its own commit.
    for (const bank of snap?.banks ?? []) markBankSeen(bank);
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!ENABLED) return;
    // Never synthesise a system prompt out of nothing — only extend one pi already built.
    if (typeof event?.systemPrompt !== "string") return;
    const snap = snapshotFor(ctx);
    if (!snap) return;
    // 2026-08-22: claude-bridge rebuilds Claude Code's preset from pi's STRUCTURED prompt
    // options (custom/append/contextFiles/skills) and silently drops raw systemPrompt
    // appends — this injection was dead in every bridge session (the model only ever saw
    // AGENTS.md, which rides along as a context file). Deliver the snapshot as a
    // persistent first-turn message there instead: stored in the session, forwarded like
    // any conversation content, replayed from history on resume.
    if (ctx?.model?.baseUrl === "claude-bridge") {
      if (branchHasIndex(ctx)) return;
      return { message: { customType: "memory-bank-index", content: snap.text, display: false } };
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${snap.text}` };
  });

  if (WRITE_ENABLED) {
    pi.registerTool({
      name: "memory_write",
      label: "Memory bank",
      // One complete description and no promptGuidelines (2026-10-18). On the Claude bridge, pi's
      // guideline bullets never reach the model (the bridge sends Claude Code's preset plus pi's
      // context, skills and sections), so the four rules that lived only there were invisible to
      // Opus/Sonnet/Haiku, while Codex models read most of the rest twice. Re-run the hygiene eval
      // (knowledge/memory-hygiene-eval.md) before changing this wording.
      description:
        "Record durable knowledge in the memory bank: the bank for the current directory, or with scope 'machine' the machine-wide bank (facts about this machine's hardware, OS or tooling that hold in every directory). " +
        "Store what a later session needs and could not re-derive: a preference or correction from the user, a decision and its reason, a trap, a measured number with its date. " +
        "Never store what the repo, docs or git already say, what only mattered in this conversation (a run id, a branch, today's quota), or a secret value (key, token, password): record where it lives; the tool refuses one. " +
        "Write final knowledge, not the story of finding it: no investigation narrative or superseded attempts. If the residue is one rule, write one rule. " +
        "Before save, check the injected index (a snapshot from session start) for the note that already owns the subject, and change that note instead: a new incident in a system that has a memory belongs inside it. " +
        "Change a note with the smallest action: edit (exact oldText→newText replacements) or append (text at the end); update replaces the whole body (or, with no body, only title/hook/description/type/asserts), so use it only to rewrite. " +
        "Correct a changed fact in place with its date, never by appending a contradiction; when your work makes another note's fact wrong, fix that note too. " +
        "rename and move (to the other bank) carry the index line and [[links]]; remove retires a note to the trash. " +
        "Types: user (who the user is), feedback (how they want you to work; needs **Why:** and **How to apply:**), project (ongoing work or constraints not derivable from the code; needs **Why:**), reference (pointers to external resources). " +
        "Use absolute dates and link related notes as [[name]]. " +
        // Local addition 2026-09-12: state the budget in units the model can steer by (words), below
        // the limit. Character counts alone produced rejections at 0.7-5% over the cap; see bodyCapFor.
        "Aim for a body under ~600 words and a hook under ~20. A write that breaks a content rule is not lost: it is staged as a draft and the error names the shortfall; finish it with draft:true and only the fix, never by re-sending the note. " +
        "Fix a hygiene warning (relative date, similar note, dangling link, story wording) with an edit before moving on. Bank notes change only through this tool, never edit or write.",
      promptSnippet: "Record or retire a durable fact in the shared memory bank",
      parameters: WRITE_SCHEMA as any,
      // pi 0.85.1 (packages/agent/src/harness/execution/tools.ts) hard-sets isError:false on any
      // VALUE a tool returns and only sets isError:true when execute THROWS. Every rejection
      // runWrite builds with fail() — bad name, missing body, lean-gate, duplicate — therefore
      // reached the model as a SUCCESSFUL tool result, so a refused write read as a completed one.
      // runWrite keeps returning result objects (the suite asserts on them); the boundary is where
      // the contract is honoured: an isError result becomes a throw.
      // The model needs the whole result (paths, hygiene warnings, the sibling feed); the person
      // watching needs what happened. Ctrl+O expands to the full text.
      renderCall(args: any, theme: any) {
        const what = [args?.action, args?.name].filter(Boolean).join(" ");
        return textBlock(`memory ${what}`, (s) => theme.fg("toolTitle", s));
      },
      renderResult(result: any, { expanded }: any, theme: any, context: any) {
        const text = resultText(result) ?? "";
        if (expanded) return textBlock(text, (s) => theme.fg("toolOutput", s));
        // A refusal is the model's to fix (it retries); one dim line is enough for the person watching.
        if (context?.isError) return textBlock(text.split("\n")[0].slice(0, 120), (s) => theme.fg("muted", s));
        return textBlock(resultHeadline(text), (s) => theme.fg("muted", s));
      },
      async execute(_toolCallId: string, params: any, _signal?: any, _onUpdate?: any, ctx?: any) {
        let result: any;
        try {
          result = await runWrite(params, ctx?.cwd ?? process.cwd());
        } catch (err: any) {
          throw new Error(`memory_write failed: ${err?.message ?? String(err)}`);
        }
        if (result?.isError) throw new Error(resultText(result) || "memory_write failed.");
        return result;
      },
    });
  }

  if (WRITE_ENABLED) {
    // A hand edit of a note skips the lock, the commit and the index line — and on 2026-10-17 a trial
    // run hand-edited a note in a bank its session was not using, through a path AGENTS.md names.
    // Where memory_write can make the change, send the change through it. Only notes in the two
    // banks the tool reaches: blocking any other bank would leave no tool path at all. MEMORY.md
    // stays hand-editable — moving lines into sections is not something the tool does.
    pi.on("tool_call", (event: any, ctx: any) => {
      if (event?.toolName !== "edit" && event?.toolName !== "write") return;
      const raw = event?.input?.path ?? event?.input?.file_path;
      if (typeof raw !== "string" || !raw.endsWith(".md") || path.basename(raw) === "MEMORY.md") return;
      const active = (pi as any).getActiveTools?.();
      if (Array.isArray(active) && !active.includes("memory_write")) return;
      const cwd = ctx?.cwd ?? process.cwd();
      const dir = path.dirname(path.resolve(cwd, raw.replace(/^~(?=\/|$)/, os.homedir())));
      const here = resolveBank(cwd).dir;
      if (dir !== here && dir !== HOME_BANK) return;
      const name = path.basename(raw, ".md");
      const scopeArg = dir === here ? "" : ', scope:"machine"';
      return {
        block: true,
        reason:
          `${raw} is a memory-bank note: change it with memory_write, which commits it, keeps its index line in step and holds the lock other agents use. ` +
          (event.toolName === "edit"
            ? `The same replacement: memory_write({action:"edit", name:"${name}"${scopeArg}, edits:[{oldText, newText}]}); append adds text, update replaces the body.`
            : `memory_write({action:"save", name:"${name}"${scopeArg}, …}) creates a note, update replaces a body.`),
      };
    });
  }

  pi.registerCommand("memory", {
    description: "Which memory bank this session resolved, and how stale its snapshot is",
    handler: async (_args: string, ctx: any) => {
      const cwd = ctx?.cwd ?? process.cwd();
      const resolved = resolveBank(cwd);
      const lines: string[] = [`cwd:  ${cwd}`, `bank: ${resolved.dir}`, `via:  ${resolved.via}`];
      if (!ENABLED) {
        lines.push(
          OFF ? "injection: OFF (PI_MEMORY_BANK)" : "injection: OFF (child launched with inheritProjectContext:false)",
        );
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const snap = snapshotFor(ctx);
      if (!snap) {
        lines.push("injection: none — no readable MEMORY.md at session start");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      lines.push(
        `in prefix: ${(snap.bytes / 1024).toFixed(1)} KB (~${Math.round(snap.bytes / 4)} tok) from ${snap.banks.length} bank(s), taken ${fmtAge(Date.now() - snap.takenAt)} ago${snap.restored ? " (restored with the resumed session)" : ""}`,
      );
      for (const bank of snap.banks) {
        let live: fs.Stats | null = null;
        try {
          live = fs.statSync(indexIn(bank));
        } catch {
          /* deleted since the snapshot */
        }
        if (!live) lines.push(`  ${bank}: index is gone now — the prefix keeps the snapshot`);
        else if (live.mtimeMs > snap.takenAt)
          lines.push(
            `  ${bank}: CHANGED ${fmtAge(Date.now() - live.mtimeMs)} ago — prefix still holds the session-start copy (intended; refreshing re-bills the context)`,
          );
        else lines.push(`  ${bank}: unchanged since the snapshot`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
