# Changelog

## [2.0.0] - 2026-11-25

- Banks moved into pi's folders: a project's bank is `<project>/.pi/memory`, the machine bank
  `~/.pi/agent/memory` (was `~/.claude/projects/<slug>/memory`). Existing banks are not moved:
  move their files by hand.
- Every bank is its own git repo. A bank inside a project repo gets a nested repo and a line in the
  project's local `.git/info/exclude`; notes are never committed into the enclosing repo.
- `--all` in pi-bank-verify and pi-bank-lint: this directory's bank and the machine bank.
- The bank-verify mirror honours `PI_MEMORY_BANK_MACHINE_DIR` and finds the home folder on Windows.

## [1.0.0] - 2026-11-23

- First release.
