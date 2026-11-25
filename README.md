# pi-arc-memory-bank

A durable memory bank for [pi](https://github.com/earendil-works/pi):
injected once per session, verifiable against the machine, and linted for the collector's fallacy.

```
pi install git:github.com/arda-kahraman/pi-arc-memory-bank
```

Updates come with `pi update --extensions`.

## What it is

Markdown notes in a per-directory bank, plus an index that is injected into the system prompt
**once per session and frozen for its lifetime**. Frozen matters: a bank that re-injected on every
turn would invalidate the prompt cache each time a note changed, so the index you start with is the
index you keep, and later edits land on disk for the next session.

Banks live in pi's own folders:

```
<project>/.pi/memory/       project bank (the project root: the nearest folder with .git or a manifest)
~/.pi/agent/memory/         machine-wide facts
```

Worktrees resolve to the main repo's bank. `PI_MEMORY_BANK_DIR` overrides everything.

Each bank is its own git repo, so an edit keeps the old value in history. A project bank inside a
git project gets a nested repo and a line in the project's local `.git/info/exclude`: the notes
never enter the project's history, and no project file changes. To share a project's notes, push
the bank's own repo.

## The tools

```bash
pi-bank-verify        # check every path, unit and command a note claims still exists
pi-bank-lint          # find notes that reach no session, dangling links, unchecked growth
```

`pi-bank-verify` is the part that makes a bank trustworthy rather than merely large. Every note is
a claim about a machine, and machines change; a note that confidently names a file deleted three
weeks ago is worse than no note. So paths written in the prose are extracted and checked, and
`asserts:` in the frontmatter carries the two things prose cannot express — `{path: P}` for "this
must exist" and `{absent: P}` for "this must NOT".

A note about a *different* machine declares `host:`, and its paths are then reported as
unverifiable-from-here rather than missing.

## The doctrine ships with it

`skills/memory-curation` is the other half: how to write a note, when **not** to, how to supersede
one whose fact changed, and how to thin a bank that has grown. Code without it leaves an agent with
a filing cabinet and no filing rules — and the failure mode of a memory system is not forgetting,
it is accumulating.

The rule that matters most: **a memory transfers final knowledge, not the story of finding it.**
Current truth, invariants and traps, measured numbers with dates, decisions. Never investigation
narrative, never superseded attempts.

## Writing a note

The extension registers a `memory_write` tool — `save`, `update`, `remove` — that maintains the
index line, the frontmatter and the git history for you. Notes link each other as `[[slug]]`.

Size is enforced, deliberately: a body over ~4500 characters is refused unless it carries a written
`size_justified` reason, which is then recorded in the note so the exemption is reviewable instead
of being a one-shot bypass nobody can see.

## Licence

MIT.
