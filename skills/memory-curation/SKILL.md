---
name: memory-curation
description: How to write, change, verify and maintain a durable memory bank, and why. Use when writing or editing a memory, deciding whether something is worth remembering, resolving a note that contradicts the machine or another note, superseding a changed fact, thinning a grown bank, acting on a drift report, or setting up or taking over a bank.
---

# Memory curation

A memory bank is a set of plain markdown notes in git, plus a one-line-per-note index injected once
per session. Everything else — search indexes, verification reports, caches — is **derived and
disposable**.

Operations come first here on purpose: an agent that loads this mid-task needs the procedure, not
the argument. The reasoning is at the end, and the evidence behind it lives in the
original harness's research notes, which are not shipped with this copy.

## The one-paragraph version

Write down only what cannot be re-derived. Say why, not just what. When a fact changes, supersede it
explicitly rather than editing in place and hoping. Never let a model be both the author and the
judge of its own knowledge. Treat "I could not check this" as a distinct answer from "this is fine".
And remember that the bank's real limit is not disk or context, it is how much a human can keep
true — everything past that line rots silently and takes the good notes' credibility with it.

---

# Operations

## Which bank am I writing to?

⚠ **The bank is resolved from the working directory, not from `$HOME`.** The exact-cwd bank if it
has one, else the nearest project root's, worktree-aware; `$HOME` is never a project root. So the
same command in `~/Dev/SomeProject` and in `~` writes to different banks.

The session's system prompt names the active one after `Bank:`. The index snapshot injected with it
is **frozen for the session** — a note you write now will not appear in your own injected index, and
that is by design, because re-injecting it would break the prompt cache. The bank on disk is what
counts.

## Writing a memory

1. Apply rule 3 and rule 5 below. Most candidate memories die here, correctly.
2. Pick the narrowest existing note it belongs in before creating a new one. What belongs at all, and what never does: *Hygiene* below.
3. Lead with **Why:** — the reason this note exists. A note that only says *what* cannot be
   maintained, because nobody can tell whether a change to it is an improvement.
4. Date measurements and name their method.
5. Convert relative dates to absolute. "Last week" is wrong forever after next week.
6. Link related notes as `[[their-name]]`.
7. Aim for under ~600 words of body and ~20 words of hook. The limits are **4500 characters of body
   for a new note** (an existing one may grow by half, up to 8000) and **200 of hook**. A write past
   them is not lost: `memory_write` stages it and names the exact shortfall, and you finish it by
   cutting the least that reaches the limit — see *Thinning*. Override with `sizeJustified` only for a
   genuine consolidation, meaning facts that are only useful together.
8. **Ask what the note can be held to** — see *Making a note checkable*.

### With `memory_write` (pi)

`memory_write` writes the note, the frontmatter fields and **the index line**, under an `O_EXCL`
lock that is the only concurrency guard between the two agents sharing this bank, and commits them.

**Change a note with the smallest action that fits.** Re-sending a whole body to change one line
costs the full note in output and is how facts get dropped.

| To | Use |
|---|---|
| change or delete a passage | `edit` with `edits: [{oldText, newText}]`: exact text, each must match once |
| add a fact | `append` with `text` |
| replace the body | `update` with `body` |
| change only title, hook, description, type, asserts or host | `update` with just those fields |
| give it a better name | `rename` with `newName`: the index line, `name:` and `[[links]]` follow |
| file it in the other bank | `move` with `to: "here"` or `"machine"` |

**A refused write is staged, never lost.** A body or hook over its limit, or a feedback/project
note with no reason, comes back as *Not written yet — staged as a draft*, with the exact fix: how
many characters to cut, or that a `why:` line is missing. Answer with `draft: true` and **only the
fix** (`edits` that cut, a shorter `hook`, a `why`), and the original write completes. Never
re-send the note. Measured before drafts existed (2026-10-17, 85 refusals): every retry re-sent the
whole note, and size retries rewrote it from memory and cut 25–35% to be safe.

- Pass `asserts`, `host`, `sizeJustified` and `why` directly to any write. `why` becomes a leading
  `**Why:**` line when the body has none.
- Shared notes are symlinks into another repo. A write goes to the link's target and keeps the
  link; the response names the repo where the change is now uncommitted. `remove` retires only the
  link.
- The only outright refusals are the ones that would lose or corrupt data: a name that is not a
  plain slug, saving over an existing note, an `edit` whose `oldText` does not match exactly once,
  `rename`/`move` onto an existing note, and finishing a draft whose note changed meanwhile.
- ⛔ **Do not hand-edit what the tool can do.** A hand edit skips the lock, the commit, the index
  line and trash-on-remove. While `memory_write` is active, the `edit` and `write` tools are
  redirected to it for notes in the two banks it reaches (`MEMORY.md` stays hand-editable, and so
  does another project's bank, which the tool cannot reach).
- After a write, the response lists **hygiene warnings** for what it just added: a relative date, a
  similar note that may be its twin, a `[[link]]` to nothing, session-story wording, a line an
  `edit` or `update` dropped without restating (its code, numbers or paths appear nowhere in the new
  note), and appended text that shares no word with the note's subject. Fix them with an
  `edit` before moving on. A credential is refused outright, and is never staged as a draft.
- ⛔ **Do not add an index line yourself** — the tool already wrote one. A second line is a lint error.
- `sizeJustified` takes a **reason string**, not `true`. It is written as `size_justified:`, which
  `pi-bank-lint` honours, so the exemption is recorded and reviewable rather than a silent bypass.

Two things happen at the write that do not happen later:

- **A malformed assertion is rejected immediately**, rather than becoming an "unrecognised assertion
  shape" in a sweep three weeks later when nobody remembers it.
- **Explicit assertions are checked against the machine.** Storing a `path:` that does not exist
  still succeeds, but returns *⚠ Stored, but already untrue on this machine*. A note that arrives
  wrong is a bug at birth.

⚠ Extension changes need a **restart**: a running session keeps the tool schema it started with.

### Without `memory_write`

Not every agent that writes to this bank has the tool, so **check rather than assume**. Claude Code
does not have it. A foreground subagent does, and gets the `Bank:` line too — verified by asking one
— but an **async background child may run without the ambient extensions**, and then has neither the
tool nor any injected index. If you cannot see `memory_write`, you are in this case.

Writing by hand is legitimate; doing it incompletely is not. You must do by hand everything the tool
would have done:

1. Create `<bank>/<name>.md` where `<name>` matches the `name:` field: a lowercase slug joined by `-` or `_`, following the bank's existing convention.
2. Write the frontmatter (below). `name`, `description` and `metadata.type` are required.
3. `git init` the bank if it is new, and commit as you go — nothing does it for you on this path.
4. **Add the index line to `MEMORY.md` yourself**, under the right `##` section:

   ```markdown
   - **[Title](note-name.md)** — what it is worth reading for.
   ```

   A note with no index line reaches nobody. `pi-bank-lint` reports it as an error.
5. Keep each line a **pointer, not a summary**, and under 280 characters. The index is the only text
   injected into every session, so it is the only part with a per-session token cost. A hook too
   vague to cause a read turns the whole index into rent; a hook that repeats the note's contents
   makes every session pay for them.

## Hygiene: what a bank holds, and how it stays clean

A note earns its place by changing what a later session does. Everything else is rent: it costs
every reader attention and makes the true notes harder to trust.

**Belongs in a memory**
- a decision and its reason, attributed (who decided, when)
- a trap, and what is NOT true — a dead end recorded as a fact ("not the cause: clock skew")
- a measured number, with its date, method and the machine it was taken on
- a durable preference or correction from the person, with how to apply it
- a pointer to where something lives when finding it was expensive

**Never belongs in a memory**
- ⛔ a secret value: a key, token, password, private key or session cookie. Record where it lives
  (`.env`, key `STAGING_API_KEY`; a secret manager entry), never the value — even when asked to
  "remember the key". `memory_write` refuses one outright.
- what the repo, its docs, `--help` or git history already say: link to it instead
- what only mattered in this conversation: progress reports, a run id, a PID, a branch name, today's
  quota, a one-off date
- the story of the session: how you got there, in order. Keep the conclusion, the dead ends as
  facts, and the number that settled it.
- a guess stated as a fact. If it is unverified, say so in the sentence.

**Keeping it clean**
- **One subject, one note.** Before a save, find the subject's existing home — the index, then the
  files — and edit or append there. A note beside its twin splits the truth in two.
  `memory_write` names similar notes after a save; fold a twin in and remove it.
- **Correct in place.** When a fact changes, edit the sentence that states it and date the new
  value ("120 s since 2026-10-15; was 90 s"). Never append a contradicting line or keep a history
  section — git holds the prior value.
- **The right bank.** Would it be just as true in another project on this machine? Then it is a
  machine fact (`scope: "machine"`, or `move` it there).
- **Absolute dates.** "Today", "yesterday", "next Monday" are wrong a day later. `memory_write`
  flags them; replace them with the date.
- **Small and linked.** Aim for ~600 words; link related notes as `[[name]]` rather than repeating
  them. A link to a note that does not exist is flagged.
- **Fix what your work invalidated.** When you change a thing another note describes, edit that note
  in the same session.
- **Sweeps catch what the write could not.** Claude Code and hand edits never pass through
  `memory_write`, so `pi-bank-lint` repeats the content checks for every write path: a
  credential-shaped string (masked in the report), a relative date (a generic present-tense use
  can carry `RELATIVE-OK` on its line), and a new feedback/project note with no **Why:** line. It
  also checks structure, size and links, and `pi-bank-verify` checks claims against the machine.
  Both run on a cadence; see *Cadence*.

## Making a note checkable

Two questions, both answered at the write:

**Does it describe a different machine?** Pass `host:`. Otherwise its paths are checked against
*this* one, and a generic path like `/etc/fstab` will pass by coincidence — false confidence, which
is worse than drift.

⚠ **`host:` is note-wide.** A note that mixes local and remote paths loses verification of the local
ones, which become `unchecked` rather than checked. If a note genuinely covers both machines, split
it; that is the only fix.

**Does it claim something prose cannot express?** Pass `asserts:`. In practice this is almost always
`{absent: PATH}` for "this must NOT exist" — a sentence like *"⛔ no `~/.config/old/`"* reads as a
positive claim to any extractor and would otherwise be reported as drift forever.

```yaml
asserts:
  - path: ~/.pi/agent/extensions/my-tool.ts
  - absent: ~/.pi/agent/extensions-disabled
```

`path:` and `absent:` are the only assertion kinds. `unit:` and `cmd:` were removed — zero notes used
them, and the implementation had five separate ways to report a command it could not run as a
command that failed. State service and command facts in prose.

Paths written normally in prose are extracted automatically, and that covers most notes. But it is
not free of judgement: a path containing shell metacharacters, a brace set, or a `<placeholder>` is
reported **unchecked**, not checked. **Read the report for your own note after writing it.** If
something you meant as a claim came back unchecked, prose was the wrong place for it.

## Acting on a drift report

`DRIFT` means the tool evaluated a claim and the world disagrees. In this order:

1. **Check whether the path moved rather than died.** ⚠ A missing path does not prove a workflow was
   retired — it usually means it was renamed or relocated. Find the new location and fix the note.
   Deleting a true fact because its path changed is the most expensive mistake available here.
2. **If the sentence is genuinely about a past or conditional state**, mark it exempt with a
   category and a reason — see *Exemptions*.
3. **If the fact is dead**, delete the sentence. Git holds the prior value; the bank is a git repo.
4. **If you cannot tell** — and especially if the note records somebody's decision — ask rather than
   guess. A wrong deletion is invisible afterwards.

Do not "fix" drift by deleting the claim to make the report green. A green report bought that way is
worth less than the drift was.

## Verifying

```
pi-bank-verify                 # the bank for THIS directory: pass / drifted / unchecked
pi-bank-verify --all           # every bank under ~/.claude/projects that has a MEMORY.md
pi-bank-verify --quiet         # drift only; the unchecked count still shows in the summary
pi-bank-verify --json          # for a scheduled sweep; carries hosts and integrity findings
sudo pi-bank-verify            # also resolves root-only paths (/etc/sudoers.d, /etc/wireguard)
pi-bank-lint                   # the other question: is the bank internally consistent
```

⚠ Because the bank is resolved from the working directory, **never rely on a bare call from a
service whose directory you do not control**. Use `--all` for anything scheduled. Project banks are
the ones nobody looks at, and they are where unchecked claims accumulate.

⚠ `sudo` changes the answer twice over. Its pass set is a superset of the unprivileged one, so the
two runs are not comparable — use it to investigate, not as the routine. And it **silently strips
`PI_MEMORY_BANK_DIR`**: a pinned bank becomes the cwd-resolved one, so you verify a different bank
than you pinned and nothing says so. Verified 2026-09-19. **`sudo -E pi-bank-verify` keeps the
pin**; plain `sudo` does not.

`pi-bank-verify --resolve [dir]` prints which bank a directory resolves to without checking
anything — the quickest way to confirm you are about to read the bank you think you are.

`pi-bank-lint` asks whether the bank is coherent — every note indexed, no dangling `[[links]]`, no
bloated entries. `pi-bank-verify` asks whether it is still *true*. Both are needed; neither implies
the other, and a perfectly tidy bank can be uniformly wrong about where its own files live.

Three states, and the third is the point:

| state | means |
|---|---|
| pass | evaluated against the machine, true |
| drifted | evaluated, false — the world moved |
| unchecked | **not evaluated** — another host, a template placeholder, a path with shell metacharacters, a truncated token, a root-only path, or a note that could not be read |

Drift fails the run, and so does an **integrity finding** — a duplicate frontmatter key, an unknown
`host:`, an exemption naming no subject — because each means the bank could not be read
unambiguously. Unchecked never fails: it is not evidence of a problem, it is an honest admission.
Treating it as either good or bad news is the mistake.

A glob is *resolved*, not skipped: a pattern matching nothing is drift, which is how a renamed
collector or a vanished directory surfaces. ⛔ But a glob passes on **one** match, so it cannot
express "exactly these four exist and nothing else".

⛔ **A note whose file cannot be read is reported, never fatal.** Banks commonly symlink notes into a
git repo, so one moved checkout breaks many at once; aborting there would report nothing about all
the rest.

### What green does NOT mean

⛔ This verifies **paths** — the least dangerous content in a note. The authority is in the ⛔ rules
an agent reads and obeys, and **nothing checks those**. A note instructing an agent to do something
catastrophic verifies clean. Green means the filesystem still matches the prose, never that the bank
is true or safe.

Nor is a pass a proof of the sentence. `probe()` is a `stat`: it does not distinguish a file from a
directory or a broken symlink, and a note about the *contents* of `/etc/fstab` passes for as long as
the file exists. Most passes are weaker than the claim they sit next to. They are still worth having
— a path that moved is the single most common way these notes go wrong — but do not read the pass
count as a health score.

⛔ **The tool runs no commands, from prose or frontmatter.** The execution path was deleted rather
than guarded: a bank is a control plane, and a persistent store is a demonstrated prompt-injection
surface.

## Exemptions

A note may legitimately name a path that is not present, and saying so is not the same as hiding
drift. So the marker carries a category, a reason, and — **required** — the subject it covers:

```markdown
The old config lived at `~/.config/waybar` <!-- VERIFY-OK historical ~/.config/waybar: Quattro deleted it -->
```

⛔ **Name every path the marker should suppress.** The exemption applies only to the paths listed
after the category. A marker naming none suppresses nothing and raises an integrity finding — the
failure is deliberately in the direction of checking more. This matters because notes wrap one
paragraph per line: a marker written for one dead path used to switch off every live claim sharing
that paragraph, including, in one real case, the very script the note existed to document.

| category | use when |
|---|---|
| `historical` | the prose narrates a past state on purpose — "was an orphan", "which moved to", "legacy fallback" |
| `ephemeral` | regenerates whenever something runs, or was a dated one-off backup |
| `conditional` | exists only in a particular state — on battery, after a crash, once a second account is added |
| `negation` | the sentence claims the path must NOT exist; pair it with an `absent:` assertion so the claim is proven rather than merely skipped |
| `illustrative` | an example path, not a claim about this machine |

If you cannot name a category, the path is probably real drift. Fix the note instead.

Every run reports the number of **claims** suppressed, by category. An exemption nobody can see is
how a verification report starts lying — and a count of markers rather than claims is how it
understates itself.

⚠ Put the marker on the **prose** line, never on an `asserts:` line. The assertion block is data.

## Thinning

`pi-bank-lint` flags a note over ~8000 bytes that grew against its git baseline. Thinning removes
narrative, never facts: the investigation story goes; measured numbers, traps, negative results and
decisions stay. The test is not "is this prose?" but **"would a future session act differently
because of this sentence?"** — a counterfactual or a dead end that stops someone repeating work is a
fact, not narrative.

Two moves before trimming words, in order:

1. **Does a section belong somewhere else?** A paragraph really about another topic should move to
   that topic's note and leave a link. Best outcome — the bank gets smaller *and* each fact ends up
   where someone will look for it.
2. **Is it irreducible?** Some notes are dense because the facts are only useful together. Record
   that decision rather than let the warning repeat forever:

   ```yaml
   size_justified: "four collectors, one widget contract, and traps that only make sense together"
   ```

Thin with `edit` deltas that delete or tighten named passages, never by regenerating the note: a
rewrite from memory drops facts nobody chose to drop. A staged draft says how many characters to
cut, so cut that many, narrative first.

⚠ Thinning is destructive and easy to get wrong at speed. Commit first, work one note at a time, and
show the person 2–3 candidate files before deleting anything. One writer per bank.

## Cadence

A verifier nobody runs is worth nothing, and rot is self-concealing — once a note stops matching
reality, readers route around it, so it stops being opened and therefore stops being corrected.

Two schedules, because they catch different things:

- **A daily sweep over every bank** (`pi-bank-sweep`, a systemd user timer). Catches project banks
  that nobody opens and that no package update touches.
- **A check after system updates** (for example a post-update check script). A package update is exactly
  when paths move — one desktop-environment upgrade invalidated claims in five notes at once.

⛔ Whatever runs it, the wrapper must **check that the tool actually ran**. Inferring health from the
absence of a drift line means every crash reports success: no output, no drift line, "clean". Count
completed summaries against banks opened, and treat a shortfall as a failure. Never log a bare
"clean" without the unchecked total beside it.

## Bootstrapping a bank from nothing

1. `mkdir -p <bank>` and create `MEMORY.md` with a title and one `##` section per theme.
2. Write notes only as real facts arrive. An empty bank is correct; a bank pre-filled with
   speculation is worse than none, because it teaches the reader to distrust it.
3. Add index lines as you go — a note with no index line reaches nobody.
4. Put the bank under git immediately. That is your transaction-time axis and your undo.
   `memory_write` now does this for a bank it creates, because the instruction alone had no reach:
   two sessions built a bank on 2026-09-19 and neither ran `git init`. A bank you make by hand is
   still yours to initialise. ⚠ It initialises but does **not** commit — an in-place edit only has
   an undo if the prior value was committed, so commit your notes.
5. Run `pi-bank-lint` and `pi-bank-verify` once the bank is non-trivial, and fix what they say.
6. Do not build search, embeddings or a graph. An index plus `grep` is sufficient at the sizes these
   banks actually reach; the failure mode of a real bank is staleness, not retrieval.

   **Measured 2026-09-19** on synthetic banks of 100/300/600/1200 notes: `pi-bank-verify` is
   sub-linear and never exceeded 70 ms; `pi-bank-lint` is linear at ~0.9 ms/note, 1.1 s at 1200.
   Neither is ever the constraint. ⛔ **The injected index is** — it rides in every session opened
   in that directory, forever.

   ⚠ **Use ~45 tokens per note, not the 28 those synthetic banks reported.** The synthetic notes
   had generated index lines; real ones have hand-written hooks, and they are ~1.6× longer.
   Re-measured 2026-09-20 on two real indexes by the same bytes/4 basis `/memory` itself uses: a
   103-note bank at 178 bytes/note ≈ **44 tok/note**, and the 33-note shared set at 194 bytes/note
   ≈ **48 tok/note**. So budget ~4.5k tokens at 100 notes, ~27k at 600, ~54k at 1200 — roughly
   double what the synthetic figure implied, which is the difference between "thin it eventually"
   and "thin it now".

   ⛔ Do not re-cite any of these as the answer for a specific bank; they are planning rates and
   they move with how richly the hooks are written. `/memory` prints the live figure for the
   session asking. That is the budget worth watching, and it is why an index line is a pointer
   rather than a summary. Thin the bank or split the project before the index becomes rent.

---

# Why

Five rules that change what you do. Each has a reason, because a rule you understand transfers to
cases it does not literally cover. The full argument and its sources are in the briefs.

**1. Never let a model be both author and judge of its own knowledge.** Self-assessed memory scores
*below* plain retrieval. Something outside the model — the filesystem, a test, a person — has to be
able to say no. This is the reason verification exists at all, and the reason it is a separate tool
that cannot write to the notes.

**2. "Could not check" is a third answer.** Every drift tool ever built ships a documented route to
confident-wrong-green, and it is always the same shape: an unevaluated check rendered
indistinguishable from a passing one. Keep the third state visible at every layer — in the claim, in
the summary, in the log line, in the notification.

**3. Write only what cannot be re-derived.** The collector's fallacy: collecting is mistaken for
knowing, and an oversized store costs attention on every read while the marginal note adds nothing.
The test is whether a future session would *act differently*.

**4. Say why, and record causality, counterfactuals and negative results.** These are the expensive
parts — what was tried and failed, what looked right and was not. Without them the next session
relitigates a decision that was already paid for. Attribute decisions: an unattributed decision
invites exactly that.

**5. Supersede explicitly; never leave two answers standing.** Under proactive interference a model
returns the *overwritten* value with confidence, and instructing it to prefer the most recent gives
only marginal relief. Edit the claim in place and say what it replaced. Do not append a
contradicting sentence, and do not keep a "history" section the default read cannot avoid — git
holds the prior value.

⛔ Do not re-propose, unless you have evidence the briefs do not: vector or embedding retrieval,
LLM-extracted knowledge graphs, automatic extraction or self-editing memory, ranking by usage,
hosted memory APIs. Each was examined against measured results and rejected; the reasoning is in
`[[memory-system-design]]` and in the briefs, not in this file, so that this file stays a procedure.

## Traps

- **A check that did not run looks like a check that passed.** The most common failure in this
  domain, and it recurs at every layer: in the checker, in the wrapper that calls it, in the log line
  a human reads.
- **A measurement is only as good as what it was measured on.** Dated, attributed and correctly
  obtained does not make it transferable — check the subject matches the case you are about to
  apply it to. The index rate above was all four of those things and still wrong for every real
  bank, because it came from synthetic notes. Two sessions hit this shape on the same day
  (2026-09-20): that rate, and a transport benchmark taken at one context size and quoted for a
  much larger one. ⚠ The write-time checks cannot catch it — a date and a method are exactly what
  such a number already has.
- **A stale note stops being read, so it stops being noticed.** Rot is self-concealing; only a
  mechanical sweep finds it.
- **A `host:` typo is a permanent silent opt-out.** Every claim in the note becomes unchecked and the
  run still passes. Validate against a roster — `$XDG_CONFIG_HOME/pi-bank-verify/hosts`.
- **Documentation wins by attrition.** In real repositories, ~48% of resolved stale references were
  fixed by changing the *code* to match the doc. A wrong note can bend reality toward itself.

## Where the evidence is

The original harness's research notes (not shipped with this copy): fifteen briefs surveying shipped harnesses, the
academic frontier, knowledge representation and truth maintenance, retrieval, storage systems, the
PKM ecosystem, executable documentation, temporal databases, classic AI, organizational memory, novel
2026 primitives, and declarative configuration. Brief 15 holds the primary papers read directly,
with their authors' own caveats. Read the relevant brief before proposing a change to this doctrine.
