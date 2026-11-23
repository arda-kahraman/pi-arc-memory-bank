// Check whether a memory bank's claims are still true, and say plainly when it could not tell.
//
//   node lib/bank-verify.js <bank-dir> [--json] [--quiet]
//
// A memory is a snapshot: true when written, silently false some time later. The bank's own index
// says so ("verify any file, unit or flag it names still exists"), which means every reader pays a
// re-verification tax in judgment. This pays it mechanically for the subset that is mechanical.
//
// THREE STATES, AND THE THIRD ONE IS THE POINT.
// Every drift-detection tool surveyed in docs/research/agent-memory-2026-09 ships a documented
// route to confident-wrong-green: Ansible's check mode "modules that do not support check mode
// report nothing and do nothing" (counted as ok), goss silently dropping a duplicate YAML key and
// printing Failed: 0, Terraform's -refresh=false producing "an incomplete or incorrect plan".
// A check that did not run must never look like a check that passed, because an unverified note is
// visibly unverified and gets discounted correctly, while a falsely-green one does not. So:
//   pass       evaluated, true
//   drifted    evaluated, false
//   unchecked  NOT evaluated — and reported as its own number, never folded into pass
//
// WHY IT EXTRACTS CLAIMS INSTEAD OF ASKING YOU TO WRITE THEM.
// The four projects that attempt this (claims-ledger, llm-ledger, adr-kit, Open Knowledge — all
// created in 2026, all under 30 stars) require a predicate authored beside every claim. That
// authoring-cost asymmetry is the reason the idea is unbuilt at scale: doctest works because the
// claim and the predicate are the same artifact, and prose gets no predicate for free. So the
// default path here writes itself — paths already named in the prose ARE the assertions. Explicit
// frontmatter assertions exist for what prose cannot express, and are opt-in.
//
// WHAT IT DELIBERATELY WILL NOT DO.
// It does not run commands. At all, from anywhere: not from prose, not from frontmatter. A memory
// bank is a control plane — these notes carry instructions an agent obeys — and persistent memory
// is a demonstrated prompt-injection surface, so the execution path was deleted rather than
// guarded.
//
// ⛔ And be clear about the limit of that: this tool verifies PATHS, which is the least dangerous
// content in a note. The authority lives in the ⛔ rules an agent reads and obeys, and nothing here
// checks those. A note saying "⛔ always pipe this to sh" verifies 100% clean. Green means the
// filesystem still matches, never that the bank is safe or true.
//
// It also does not decide whether a claim is semantically true; like Open Knowledge's
// freshness check, it detects that the world moved, not that the sentence is now wrong. A human or
// an agent still judges. Finally it does not write to the notes: the notes are the authority, this
// output is derived and disposable.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const asJson = args.includes("--json");

const quiet = args.includes("--quiet");

// An unrecognised flag used to be ignored silently, so `--run-command` (singular) left every
// command assertion unevaluated and exited 0, looking clean. A typo in a flag must never quietly
// reduce what gets checked.
const KNOWN_FLAGS = new Set(["--json", "--quiet", "--resolve", "--all"]);
const unknownFlags = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) {
  console.error(`bank-verify: unknown flag ${unknownFlags.join(", ")}` +
    (unknownFlags.includes("--run-commands") ? " — unit:/cmd: assertions and --run-commands were removed" : ""));
  process.exit(2);
}

const HOME = process.env.HOME ?? "";
const expand = (p) => (p.startsWith("~") ? HOME + p.slice(1) : p);

// ── bank resolution ───────────────────────────────────────────────────────────
// A MIRROR of resolveBank() in extensions/memory-bank.ts, which is the source of truth. It has to
// be mirrored rather than imported because that file is TypeScript loaded by pi's own runtime.
// Without it this tool checked the $HOME bank no matter where it ran, so every project bank — and
// there are a dozen of them under ~/.claude/projects — was never verified even once while the
// session working in that project was reading it. tests/maintenance pins the documented cases.
const PROJECTS_ROOT = path.join(HOME, ".claude", "projects");
const HOME_BANK = path.join(PROJECTS_ROOT, HOME.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
const PROJECT_MARKERS = [".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "AGENTS.md", "CLAUDE.md"];

function bankForPath(dir) {
  const slug = dir.replace(/[^a-zA-Z0-9]/g, "-");
  const safe = slug.length <= 200
    ? slug
    : `${slug.slice(0, 180)}-${require("node:crypto").createHash("sha1").update(slug).digest("hex").slice(0, 12)}`;
  return path.join(PROJECTS_ROOT, safe, "memory");
}
const hasIndex = (dir) => fs.existsSync(path.join(dir, "MEMORY.md"));

// A worktree's .git is a FILE pointing into the main repo; without this every isolated subagent
// worktree resolves to its own throwaway bank.
function mainWorktreeOf(dir) {
  try {
    const dotGit = path.join(dir, ".git");
    if (!fs.statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!m) return null;
    const at = m[1].trim().indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    if (at <= 0) return null;
    const main = m[1].trim().slice(0, at);
    return fs.existsSync(main) ? main : null;
  } catch { return null; }
}

function findProjectRoot(start) {
  let cur = start;
  for (;;) {
    if (cur === HOME) return null;                 // $HOME is never a project root, on purpose
    if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(cur, m)))) return mainWorktreeOf(cur) ?? cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function resolveBank(cwd) {
  if (process.env.PI_MEMORY_BANK_DIR) return process.env.PI_MEMORY_BANK_DIR;
  let cur;
  try { cur = path.resolve(cwd || process.cwd()); } catch { return HOME_BANK; }
  const exact = bankForPath(cur);
  if (hasIndex(exact)) return exact;
  const root = findProjectRoot(cur);
  if (root) return bankForPath(root);
  if (cur === HOME) return HOME_BANK;
  return exact;
}

if (args.includes("--resolve")) {
  console.log(resolveBank(positional[0] ?? process.cwd()));
  process.exit(0);
}

const bank = positional[0];
if (!bank) { console.error("usage: bank-verify.js <bank-dir> [--json] [--quiet]"); process.exit(2); }

// Absolute paths a note asserts by naming them. Deliberately narrow: rooted at a real prefix, at
// least two segments deep, so ordinary prose ("/etc" alone, "the /home of") is not a claim.
// `~` counts only when followed by a slash: in prose a bare tilde means "approximately", and
// treating "~2.3 GB" as a path claim buried the real signal under 300 phantom entries.
// `*` is inside the class on purpose: without it the match stops short and `corpus/part*` becomes
// the literal `corpus/part`, which does not exist — a glob reported as drift. Captured whole, it is
// recognised as a pattern and reported as unchecked, which is the truth.
// Unicode-aware: `\w` is ASCII-only, so `/etc/nåïve/x.conf` matched just `/etc/n` and was reported
// as drift — a false accusation, the one output this tool cannot afford.
const PATH_RE = /(?<![\p{L}\p{N}_/])(?:~(?=\/)|\/home\/[a-z][\p{L}\p{N}_-]*|\/etc|\/usr\/(?:share|lib|local|bin)|\/var|\/opt|\/srv)[\p{L}\p{N}_./+@*-]*[\p{L}\p{N}_/*]/gu;

// These notes write paths inside backticks, and markdown's own delimiter is a far better boundary
// than whitespace: `~/Downloads/Windows Personal Files` is one path, and a whitespace-delimited
// regex truncates it to `~/Downloads/Windows`, which does not exist. That reported two correct
// notes as drift. A span counts as a path only if it is rooted and contains nothing that betrays a
// command — pipes, redirects, substitutions, or a flag like ` -f`.
// The one policy both extractors obey: which roots hold claims durable enough to be worth checking.
// /tmp, /run, /proc, /sys and /dev are working state, /mnt depends on what is mounted right now, and
// a URL path like /search/research/github is not a filesystem claim at all. Checking any of them
// produces drift that is true today and false in an hour, which trains everyone to ignore the
// report. ⚠ /dev is excluded deliberately: the dGPU powers down to D3cold, so /dev/nvidia0 comes and
// goes on a healthy machine.
// `~/` is a complete root by itself; the absolute ones must be followed by a separator or end, so
// that /etc matches /etc/foo but /etcetera is not mistaken for it.
// Must stay character-class-identical to PATH_RE's root alternation above. `\w` is ASCII-only, so
// spelling it `[\w-]` here while PATH_RE says `[\p{L}\p{N}_-]` made the two extractors disagree:
// bare prose captured /home/ádám/x.conf, the backtick-span path silently dropped it.
const DURABLE_ROOT = /^(?:~\/|(?:\/home\/[a-z][\p{L}\p{N}_-]*|\/etc|\/usr\/(?:share|lib|local|bin)|\/var|\/opt|\/srv)(?:\/|$))/u;

// Returns null for a span that is not a path claim at all (correctly ignored), {path} for one that
// can be checked, or {unchecked} for one that clearly NAMES a location but cannot be resolved.
//
// ⛔ That third case used to return null too, so the claim vanished — no pass, no drift, no
// unchecked line, nothing. `~/.cache/omarchy-agent-usage-{antigravity,codex}` and every $-bearing
// path were simply absent from the report, and a single stray quote inside a span was enough to
// hide a path from every future run without leaving a trace. That breaks this tool's one contract:
// what it cannot evaluate, it says out loud.
function pathFromSpan(raw) {
  const t = raw.trim();
  if (!DURABLE_ROOT.test(t)) return null;

  // A span like `~/.local/bin/boot-timing [label]` or `~/.pi/agent/auth.json["key"]` is a usage
  // string wrapped around a real claim: that file exists at that path. Recovering the head turns an
  // unchecked line into actual verification. The head is only trusted when it ends at a complete
  // component — `~/.config/<name>/x` yields `~/.config/` and `...agent-usage-{a,b}` yields a
  // dangling stem, and inventing a path the author never wrote is how a checker starts lying.
  const cut = t.search(/[|;&$<>(){}\[\]"']/);
  if (cut > 0) {
    const head = t.slice(0, cut).trim();
    // ⛔ The metacharacter must begin a SEPARATE token, or the head is a truncated filename rather
    // than a complete one. `hyprlandCrashReport<pid>.txt` cut to `hyprlandCrashReport` and reported
    // drift against a path nobody ever wrote — a false accusation, which is the one output this
    // tool cannot afford. A `[` subscript after a real extension (`auth.json["key"]`) is the single
    // exception, because there the filename is already complete.
    const separate = /\s/.test(t[cut - 1]);
    const subscripted = t[cut] === "[" && /\.[A-Za-z0-9]+$/.test(head);
    if ((separate || subscripted) && head.split("/").length >= 3 && /^[~\p{L}\p{N}_./+@*-]+$/u.test(head)) return { path: head };
    return { unchecked: /[<>{}]/.test(t) ? "templated" : "names a path but contains shell metacharacters" };
  }
  if (cut === 0) return { unchecked: "names a path but contains shell metacharacters" };

  // `~/.local/bin/tool --flag` — the flag proves it is an invocation, and the same head rule applies.
  const flag = t.search(/\s-{1,2}\w/);
  if (flag > 0) {
    const head = t.slice(0, flag).trim();
    if (!/[\/\-_.]$/.test(head) && head.split("/").length >= 3) return { path: head };
    return { unchecked: "reads as a command with flags, not a path" };
  }
  if (!/^[~\p{L}\p{N}_./+@* -]+$/u.test(t)) return { unchecked: "contains characters this tool cannot resolve" };
  // `/usr/bin/sunshine ~/.config/x/sunshine.conf` is a command and its argument, not one path with a
  // space in it: a second token that starts a new absolute path is a separate claim. A space inside
  // one path (`/mnt/SSD/Dev/Game Development/x`) never starts with `/` or `~/`, so it stays whole.
  const parts = t.split(/\s+(?=~\/|\/)/);
  if (parts.length > 1) return { paths: parts.map((x) => x.trim()) };
  // `~/.cache/x/run.py slot` is a script and its argument. A first token that ends in a file
  // extension and is followed by more words is an invocation; a space inside a directory name
  // (`/mnt/SSD/Dev/Game Development/x`) has no extension before it and stays one path.
  const [first, ...rest] = t.split(/\s+/);
  if (rest.length && /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(first) && first.split("/").length >= 3) return { path: first };
  return { path: t };   // `~` is not in \w; \p{L} keeps non-ASCII paths
}

// A path we can see but cannot honestly evaluate. Each is unchecked, never a pass and never drift.
function unevaluable(p) {
  if (/[*?\[\]]/.test(p)) return null;                         // resolved by checkPath via globSync
  if (/[<>{}]/.test(p)) return "placeholder";                  // <name>, {dir}
  if (p.includes("$")) return "variable";                      // $HOME/x, expanded at use
  // ⛔ Order matters. "too shallow" used to be tested first, so a RELATIVE path like
  // `tests/__init__.py` was reported as shallow — which sent the reader looking for a deeper path
  // instead of an absolute one. A relative path is not a weak claim, it is an unanswerable one:
  // what it resolves to depends on who runs the check and from where.
  if (!p.startsWith("~") && !p.startsWith("/")) return "not absolute";
  if (p.split("/").length < 3) return "too shallow to be a claim";
  return null;
}

// Frontmatter is parsed, not YAML-parsed: the assertion block is a fixed small shape, and a real
// YAML dependency would be the only one in this repo. Anything unrecognised becomes unchecked
// rather than being silently skipped — an assertion we failed to understand is exactly the case
// that must not read as green.
// Walked line by line rather than matched with one regex. The regex version used `\Z` for
// end-of-input, which is a Python/PCRE anchor: JavaScript read it as a literal `Z`, the lookahead
// never succeeded, and every assertion block parsed as empty — silently, which is the failure this
// whole tool exists to refuse.
// The frontmatter block, or "" — every key lookup goes through this. Searching the whole file for
// `host:` would let a body line claiming to be one flip a note to another machine.
// ⛔ This must not fail silently. It is anchored at byte 0 by design (YAML frontmatter has to start
// there), but it used to also require exactly "\n" — so a UTF-8 BOM or CRLF endings, which two
// agents editing these files can introduce at any time, made it return "". Everything downstream
// then read as "this note has no frontmatter": asserts: vanished uncounted, host: vanished so a
// remote note's paths were checked against THIS machine, and the frontmatter was re-extracted as
// prose, turning `absent: /gone` into a drift report for the exact thing the author asserted.
// BOM and CRLF are now tolerated; anything still unparseable is reported, never assumed empty.
function frontmatterOf(body) {
  const fm = body.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return fm ? fm[1].replace(/\r$/gm, "") : "";
}

// Did this note MEAN to have frontmatter we failed to read? Silence here is indistinguishable from
// a note that legitimately has none, which is why it needs saying out loud.
function frontmatterIssue(body, fmText) {
  const stripped = body.replace(/^\uFEFF/, "");
  if (/^\s*\n*---/.test(stripped) && !fmText) return "opens with --- but the frontmatter block could not be parsed";
  if (!fmText) return null;
  if (/^\s*asserts:/m.test(fmText) && frontmatterAsserts(body).length === 0) {
    return "declares asserts: but no assertion could be read from it";
  }
  return null;
}

function frontmatterAsserts(body) {
  const fmText = frontmatterOf(body);
  if (!fmText) return [];
  const lines = fmText.split("\n");
  // Claude Code NORMALISES frontmatter when it updates a note: top-level custom keys are moved
  // inside the `metadata:` block. The bank is shared with it, so any note it touches comes back
  // re-indented — matching only at column 0 meant a note silently lost its assertions and its host
  // marking the first time Claude Code wrote to it. Accept either placement.
  const start = lines.findIndex((l) => l.trim() === "asserts:");
  if (start === -1) return [];
  const out = [];
  for (const raw of lines.slice(start + 1)) {
    if (/^\S/.test(raw) && raw.trim() !== "") break;   // dedented to a new top-level key
    // An HTML comment on an assertion line would otherwise be swallowed into the value, turning a
    // working assertion into an unevaluable one without saying so. That happened once, to this
    // file's own notes, and it is precisely the silent degradation this tool exists to refuse.
    const line = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!line.startsWith("- ")) continue;
    const item = {};
    for (const [, k, v] of line.slice(2).matchAll(/(\w+):\s*("[^"]*"|'[^']*'|[^,]+?)(?=,\s*\w+:|$)/g)) {
      item[k] = v.trim().replace(/^["']|["']$/g, "");
    }
    out.push(item);
  }
  return out;
}

// Absent and unreadable are different answers, and conflating them makes the tool lie in the most
// damaging direction: it accuses a correct note. /etc/sudoers.d and /etc/wireguard are root-only, so
// existsSync returns false for files that are really there — three true notes were reported as drift
// before this distinction existed.
function probe(p) {
  try {
    fs.statSync(expand(p));
    return { present: true };
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { present: false };
    return { unreadable: e.code === "EACCES" || e.code === "EPERM" ? "not readable by this user" : `stat failed: ${e.code}` };
  }
}

function checkPath(p) {
  const why = unevaluable(p);
  if (why) return { state: "unchecked", detail: why };

  // A glob is still a claim: "files of this shape exist here". Resolving it converts the largest
  // unchecked class into real verification, and a pattern matching nothing is genuine drift — that
  // is how a renamed collector or a vanished session directory would show up.
  if (/[*?]/.test(p)) {
    try {
      return fs.globSync(expand(p)).length
        ? { state: "pass" }
        : { state: "drifted", detail: "pattern matches nothing" };
    } catch (e) {
      return { state: "unchecked", detail: `glob failed: ${e.code ?? e.message}` };
    }
  }

  const r = probe(p);
  if (r.unreadable) return { state: "unchecked", detail: r.unreadable };
  return r.present ? { state: "pass" } : { state: "drifted", detail: "does not exist" };
}

// ⛔ `unit:` and `cmd:` assertions were REMOVED, along with --run-commands. Two independent reviews
// converged on them: one measured zero uses across every note in every bank since the feature
// shipped, the other found five separate correctness bugs in the 8-line implementation — a bare
// catch reporting "could not run" as "evaluated, false" (this tool's own cardinal sin, inverted);
// unanchored matching, so `matches: Hybrid` passed on "not Hybrid"; no `matches` at all meaning any
// zero exit passed, making `cmd: "true"` a green assertion; a value parser that split on unquoted
// commas and so executed a DIFFERENT command than the one asserted; and `new RegExp()` built from
// note text, a ReDoS surface the 10s child timeout did not cover.
//
// Fixing five bugs to serve zero claims is backwards, and each fix would have added surface to a
// path that executes strings out of a file two agents write. `systemctl is-active` also returns
// "inactive" for a unit that does not exist, so `unit: foo, state: inactive` passed after foo was
// uninstalled. State service and command facts in prose, or as path:/absent:, until something
// actually needs more.

// An exemption that nobody can see is how a verification report starts lying. VERIFY-OK therefore
// carries a category and a reason, both greppable, and the run COUNTS them by category so the
// exempted set can be audited instead of quietly growing. Categories in use:
//   historical   the prose narrates a past state on purpose ("was an orphan", "which moved to")
//   ephemeral    regenerates when something runs, or was a dated one-off
//   conditional  exists only in a particular state (on battery, after a crash)
//   illustrative an example path, not a claim about this machine
// Must be the comment form. A bare `VERIFY-OK` anywhere in prose used to exempt its whole line,
// which meant any note explaining the mechanism silently switched it off — the handoff note did
// exactly that within an hour of the feature existing.
// `VERIFY-OK <category> <subject-path>: reason`. The subject is REQUIRED and the exemption applies
// to that path alone.
//
// ⛔ This used to exempt the whole LINE. These notes wrap at paragraph granularity — one line is
// routinely a 1,000-character paragraph naming four or five paths — so a marker written for one
// dead path silently switched off every live claim beside it. Measured on the real bank: 8 live
// claims suppressed by accident, including `~/.local/bin/omarchy-limine-theme-sync`, the script its
// note exists to document, named exactly once. Deleting it would have kept reporting clean forever.
// A marker naming no subject now suppresses NOTHING and raises an integrity line, because the
// failure has to be loud in the direction of checking more, never less.
const EXEMPT_RE = /<!--\s*VERIFY-OK(?:\s+(\w+))?((?:\s+(?:~|\/)[^\s:]*)*)/;

// A `host:` typo is a permanent, silent, note-wide opt-out: every claim becomes unchecked and the
// run still exits 0. Validating against a roster turns a typo into a visible integrity line.
//
// The roster is CONFIGURATION, not a constant. Hard-coding one machine's fleet into a tool other
// people run would invent integrity failures on every bank that names a host this list never heard
// of — a checker that cries wolf about correct notes is the failure mode this whole tool exists to
// avoid. With no roster file the check is simply off, and the hosts line still lists what was seen
// so a typo remains visible to a human.
const HOSTS_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "pi-bank-verify", "hosts");
let KNOWN_HOSTS = null;
try {
  KNOWN_HOSTS = new Set(fs.readFileSync(HOSTS_FILE, "utf8")
    .split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).concat(os.hostname()));
} catch { /* no roster configured — validation off, listing still on */ }

const notes = fs.readdirSync(bank).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort();
const results = [];
const exempt = new Map();
// Nothing validates a host: value, so a typo (`myhosI` for `myhost`) marks a note unverifiable
// FOREVER and reads as success. Listing the distinct values makes a typo visible as a stray host
// with a count of one, which is the only cheap defence against a silent permanent opt-out.
const hosts = new Map();
// Counting exempted LINES understates suppression whenever a line carries several claims, which is
// the normal shape here. The report has to state how many claims are switched off, not how many
// comments were written, or "auditable instead of quietly growing" is false at the resolution that
// matters.
let suppressed = 0;
// Exemptions whose premise has expired. Reported, but deliberately NOT a failure: nothing is wrong
// with the machine, the note is just carrying a suppression it no longer needs.
const staleExempt = [];
const integrity = [];
let pass = 0, drifted = 0, unchecked = 0;

for (const file of notes) {
  // A note that cannot be read must not kill the run. This bank links 30 notes into a git repo, so
  // a moved or deleted checkout turns every one of them into a broken symlink at once — and a
  // directory named *.md gives EISDIR. Crashing there reports nothing about the other 90 notes.
  // ⛔ Two agents write this bank and neither locks note bodies — only MEMORY.md is locked. A read
  // landing inside a truncate-then-write returns an empty or partial file, and an empty one yields
  // no claims at all, so the note DISAPPEARS from the report rather than failing. Stat on both
  // sides: if the file moved under us, say so instead of reporting whatever we happened to catch.
  // The mtime also goes into the JSON, so a green report is attributable to a bank state rather
  // than being a claim about nothing in particular.
  let body, st0;
  try {
    st0 = fs.statSync(path.join(bank, file));
    body = fs.readFileSync(path.join(bank, file), "utf8");
    const st1 = fs.statSync(path.join(bank, file));
    if (st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) {
      unchecked++;
      results.push({ note: file, mtime: new Date(st1.mtimeMs).toISOString(), claims: [{ kind: "note", subject: file, state: "unchecked", detail: "changed while being read" }] });
      continue;
    }
  } catch (e) {
    unchecked++;
    results.push({ note: file, claims: [{ kind: "note", subject: file, state: "unchecked", detail: `unreadable: ${e.code ?? e.message}` }] });
    continue;
  }
  const claims = [];

  // A note may declare that it describes a different machine. Its claims are then perfectly correct
  // and simply not checkable from here, which is unchecked — not drift. Without this, a bank shared
  // across a fleet accuses every note about another host of being wrong.
  //
  // ⛔ This MUST be computed before the assertion loop below. It used to sit after it, so `host:`
  // governed prose paths but not explicit `asserts:` — and a `- path:` in a note marked
  // `host: myhost` was checked against THIS machine. If the path happened to exist here it PASSED,
  // certifying a claim about another computer. The doctrine steers authors toward `asserts:` plus
  // `host:` together, so the recommended combination was the broken one.
  const fmText = frontmatterOf(body);

  // A duplicate key makes the frontmatter ambiguous: which host: or asserts: wins is then an
  // accident of parser order, and the two tools reading this bank need not agree.
  const keys = [...fmText.matchAll(/^\s*([A-Za-z_][\w-]*):/gm)].map((m) => m[1]);
  const dupes = [...new Set(keys.filter((k) => keys.filter((x) => x === k).length > 1))];
  if (dupes.length) integrity.push(`${file}: duplicate frontmatter key(s) ${dupes.join(", ")}`);

  const fmIssue = frontmatterIssue(body, fmText);
  if (fmIssue) integrity.push(`${file}: ${fmIssue}`);

  const host = fmText.match(/^\s*host:\s*(\S+)\s*$/m)?.[1];
  if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1);
  if (host && KNOWN_HOSTS && !KNOWN_HOSTS.has(host)) integrity.push(`${file}: host: ${host} is not a known machine — a typo here silently exempts the whole note`);
  const elsewhere = host && host !== os.hostname();

  // Explicit assertions — the author's own words about what must hold.
  for (const a of frontmatterAsserts(body)) {
    const subject = a.path ?? a.absent ?? a.unit ?? a.cmd;
    if (elsewhere) {
      claims.push({ kind: "assert", subject: String(subject ?? ""), state: "unchecked", detail: `describes ${host}` });
      continue;
    }
    if (a.path) claims.push({ kind: "path", subject: a.path, ...checkPath(a.path) });
    else if (a.absent) {
      const why = unevaluable(a.absent);
      if (why) { claims.push({ kind: "absent", subject: a.absent, state: "unchecked", detail: why }); continue; }
      // A glob has to be RESOLVED, not stat'd. `unevaluable` returns null for glob characters on the
      // grounds that checkPath expands them — but this branch never called checkPath, so
      // `absent: ~/.config/waybar/*` stat'd a literal `*` filename, got ENOENT and passed with the
      // directory full. `absent:` is what the doctrine recommends for the highest-stakes claims, so
      // that was a guaranteed-green assertion exactly where certainty was wanted.
      if (/[*?\[\]]/.test(a.absent)) {
        let hits;
        try { hits = fs.globSync(expand(a.absent)); }
        catch (e) { claims.push({ kind: "absent", subject: a.absent, state: "unchecked", detail: `glob failed: ${e.code ?? e.message}` }); continue; }
        claims.push(hits.length
          ? { kind: "absent", subject: a.absent, state: "drifted", detail: `${hits.length} match(es) still exist` }
          : { kind: "absent", subject: a.absent, state: "pass" });
        continue;
      }
      const r = probe(a.absent);
      // Same asymmetry inverted: an unreadable path must not be mistaken for a confirmed absence,
      // or an `absent:` assertion passes for the wrong reason.
      claims.push(r.unreadable
        ? { kind: "absent", subject: a.absent, state: "unchecked", detail: r.unreadable }
        : { kind: "absent", subject: a.absent, ...(r.present ? { state: "drifted", detail: "still exists" } : { state: "pass" }) });
    // A removed feature must not make existing assertions disappear. Surfacing them as unchecked
    // keeps them countable and visible; silently dropping them would be a coverage loss that looks
    // like success.
    } else if (a.unit || a.cmd) claims.push({ kind: "assert", subject: String(a.unit ?? a.cmd), state: "unchecked", detail: "unit:/cmd: assertions were removed — state it in prose, or use path:/absent:" });
    else claims.push({ kind: "unknown", subject: JSON.stringify(a), state: "unchecked", detail: "unrecognised assertion shape" });
  }

  // Then paths the prose names. A line carrying VERIFY-OK is a reviewed exception, the same idiom
  // knowledge-check.js uses for KNOWLEDGE-OK — illustrative paths and other people's machines.
  // Prose only. Scanning the frontmatter too made every explicit assertion get re-read as a bare
  // path claim, so `absent: /gone` was reported as drift for not existing — the exact inverse of
  // what the author asserted.

  const prose = body.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const seen = new Set(claims.filter((c) => c.kind === "path").map((c) => c.subject));
  for (const line of prose.split("\n")) {
    const ex = line.match(EXEMPT_RE);
    // A paragraph can retire several paths at once, so the marker takes a list. Every subject must
    // be spelled out: what is not named is still checked.
    let exemptHere = new Set();
    if (ex) {
      const k = ex[1] ?? "uncategorised";
      const subjects = (ex[2] ?? "").split(/\s+/).filter(Boolean);
      if (subjects.length) {
        exemptHere = new Set(subjects);
        exempt.set(k, (exempt.get(k) ?? 0) + subjects.length);
        // ⛔ Exemptions ratchet. Marking a drift VERIFY-OK takes ten seconds and always passes, and
        // nothing ever revisits the set — the honest end state is that the exempt count becomes the
        // drift count. There is no authoring-free way to expire most categories, but `historical`
        // makes a checkable claim: this path is gone ON PURPOSE. If it comes back, the exemption is
        // stale and is now hiding a live claim. That is mechanical, costs the author nothing, and
        // is the only category where existing again is evidence of anything: `ephemeral` and
        // `conditional` are expected to come and go, `negation` is already covered by its absent:
        // assertion, and `illustrative` was never a real path.
        if (k === "historical") {
          for (const s of subjects) {
            if (unevaluable(s)) continue;
            if (probe(s).present) staleExempt.push(`${file}: ${s} exists again — the historical exemption is stale, drop it and let the claim be checked`);
          }
        }
      } else integrity.push(`${file}: VERIFY-OK ${k} names no subject path — suppressing nothing (write \`VERIFY-OK ${k} <path>: reason\`)`);
    }
    // Backtick spans first, then the bare-prose regex over what is left. Blanking the spans out
    // stops the same path being claimed twice, once whole and once truncated.
    for (const s of line.matchAll(/`([^`]+)`/g)) {
      const r = pathFromSpan(s[1]);
      if (!r) continue;
      if (r.unchecked) {
        const subj = s[1].trim();
        if (!seen.has(subj) && !exemptHere.has(subj)) {
          seen.add(subj);
          claims.push({ kind: "path", subject: subj, state: "unchecked", detail: r.unchecked });
        }
        continue;
      }
      for (const p of r.paths ?? [r.path]) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (exemptHere.has(p)) { suppressed++; continue; }
        const why = unevaluable(p);
        if (why === "too shallow to be a claim" || why === "not absolute") continue;
        claims.push(elsewhere
          ? { kind: "path", subject: p, state: "unchecked", detail: `describes ${host}` }
          : { kind: "path", subject: p, ...checkPath(p) });
      }
    }
    const bare = line.replace(/`[^`]+`/g, (m) => " ".repeat(m.length));

    for (const m of bare.matchAll(PATH_RE)) {
      const raw = m[0];
      // A path the author templated — `~/x/proposal-<date>.md` — matches only up to the `<`, so the
      // captured stem looks like a concrete path that does not exist. Reported as drift that is a
      // false accusation against a correct note; the truth is that it cannot be evaluated.
      // If the token does not end at a delimiter, the pattern stopped INSIDE a path and `raw` is a
      // truncation, not a claim. Checking a truncation invents a shorter path that was never
      // written and then reports it missing. Two ways this happens: a template placeholder
      // (`proposal-<date>.md`), and any character the pattern cannot express. Both are unchecked.
      // Sentence punctuation closes a path. `.` is safe to treat as a delimiter because the match
      // already consumes path-internal dots greedily and can only end on a word character, `/` or
      // `*` — so a leftover `.` is always the end of a sentence, never part of the name.
      const after = bare[m.index + raw.length];
      if (after !== undefined && !/[\s`,;:)\]}'".!?…]/.test(after)) {
        const tail = bare.slice(m.index + raw.length).match(/^[^\s`,;)\]]*/)?.[0] ?? "";
        const templated = /[<{$]/.test(tail);
        if (!seen.has(raw)) {
          seen.add(raw);
          claims.push({
            kind: "path", subject: `${raw}${after}…`, state: "unchecked",
            detail: templated ? "templated" : "truncated at an unsupported character",
          });
        }
        continue;
      }
      // `*` is NOT stripped here: it is meaningful. Stripping it turned `corpus/part*` into a
      // literal path that does not exist and reported a glob as drift — a false positive, which is
      // the one output this tool cannot afford.
      const p = raw.replace(/[.,;:)`'"]+$/, "");
      if (seen.has(p)) continue;
      seen.add(p);
      if (exemptHere.has(p)) { suppressed++; continue; }
      // Auto-extraction discards what is not a claim; it does not report it as unchecked. The
      // unchecked count has to mean "a real claim this tool could not evaluate" or it stops
      // carrying information. An assertion the AUTHOR wrote is never discarded this way — see the
      // explicit block above, where the same shape is surfaced instead of dropped.
      const why = unevaluable(p);
      if (why === "too shallow to be a claim" || why === "not absolute") continue;
      claims.push(elsewhere
        ? { kind: "path", subject: p, state: "unchecked", detail: `describes ${host}` }
        : { kind: "path", subject: p, ...checkPath(p) });
    }
  }

  for (const c of claims) {
    if (c.state === "pass") pass++;
    else if (c.state === "drifted") drifted++;
    else unchecked++;
  }
  results.push({ note: file, mtime: new Date(st0.mtimeMs).toISOString(), claims });
}

// A note that yields no claim at all is invisible in pass/drift/unchecked, so an extractor
// regression makes the report GREENER rather than louder. Publishing the count gives the one signal
// that moves in the right direction when extraction breaks.
const silent = results.filter((r) => r.claims.length === 0).length;

if (asJson) {
  // `hosts` and `integrity` were human-output-only, so every --json consumer — the documented mode
  // "for a scheduled sweep" — was blind to a host: typo and to a duplicate frontmatter key.
  console.log(JSON.stringify({
    bank, checkedAt: new Date().toISOString(),
    totals: { pass, drifted, unchecked, silent, suppressed, exempt: Object.fromEntries(exempt) },
    hosts: Object.fromEntries(hosts), integrity, staleExempt, notes: results,
  }, null, 2));
  process.exit(drifted || integrity.length ? 1 : 0);
}

// One runaway note should not make the whole report unreadable: a note that pasted a directory
// listing produced 80,001 lines and 6 MB here, at which point nobody reads any of it, including the
// drift that mattered. Per-note cap with an explicit remainder — bounded, but never silent about
// what it did not print, and the summary totals are unaffected. --json is uncapped, because a
// machine reader wants everything.
const PER_NOTE_LINES = 25;
for (const { note, claims } of results) {
  let shown = 0, hidden = 0;
  for (const c of claims) {
    const show = c.state === "drifted" || (c.state === "unchecked" && !quiet);
    if (!show) continue;
    if (shown >= PER_NOTE_LINES) { hidden++; continue; }
    shown++;
    const label = c.state === "drifted" ? "DRIFT     " : "UNCHECKED ";
    console.log(`  ${label} ${note}: ${c.kind} ${c.subject} — ${c.detail}`);
  }
  if (hidden) console.log(`  …          ${note}: ${hidden} more not printed — use --json for all of them`);
}
// Unchecked is printed in the summary even under --quiet. Hiding it is the exact failure this tool
// exists to avoid.
for (const line of integrity) console.log(`  INTEGRITY  ${line}`);
for (const line of staleExempt) console.log(`  STALE-EXEMPT ${line}`);
if (hosts.size) {
  const list = [...hosts].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h}×${n}`).join(", ");
  console.log(`             notes declared elsewhere: ${list}`);
}
const byKind = [...exempt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ");
console.log(`bank-verify: ${pass} pass · ${drifted} drifted · ${unchecked} unchecked (${notes.length} notes)`);
if (suppressed) console.log(`             ${suppressed} claims suppressed by exemption — ${byKind}`);
if (silent) console.log(`             ${silent} notes yielded no claim at all`);
// A file with no index line reaches no session, so folding it into a healthy-looking total quietly
// overstates what was checked on anyone's behalf. Reported, never fatal: lint owns that judgement
// and this tool must not grow a second opinion about it. Found 2026-09-20 by a session that caught
// verify counting an unindexed file inside "7 pass" while lint flagged the same file as
// unregistered — the two tools disagreeing about what a note even is.
try {
  const indexText = fs.readFileSync(path.join(bank, "MEMORY.md"), "utf8");
  const orphans = notes.filter((f) => !indexText.includes(f));
  if (orphans.length) console.log(`             ${orphans.length} of those ${orphans.length === 1 ? "has" : "have"} no index line, so ${orphans.length === 1 ? "it reaches" : "they reach"} no session — pi-bank-lint names ${orphans.length === 1 ? "it" : "them"}`);
} catch {
  /* an unreadable index is already lint's finding, not this tool's */
}
// An integrity finding means the bank cannot be read unambiguously — a duplicate key, an unknown
// host:, an exemption with no subject. Exiting 0 on those left them advisory, printed into a log
// nobody reads. They now fail the run like drift does.
process.exit(drifted || integrity.length ? 1 : 0);
