---
"ox-dep-lint": minor
---

No source escapes the check unreported any more. This can add findings to a repository that passed before, so upgrade with the CLI once and baseline or fix what it reports.

- The walk now reads dot directories inside a package (`src/.internal/x.ts`), as oxlint already did; it skips only `node_modules` and `.git`. A tool's cache that holds generated code (`.wrangler`, `.astro`) belongs in `output`.
- `symbolic-link`: every symbolic link under a package directory, whatever it points at and whatever its name (`.d.ts`, `.md`, `.json`, extensionless), and a link a `workspaces` entry matches or names literally. Links are never followed: 0.2 read a link to a file as if it were the file and skipped a link to a directory silently. Only links inside directories the check skips on purpose are not reported: `node_modules`, `.git`, and directories that `ignore`, `output` or an unchecked file class cover through a trailing `/**`. A baseline entry names the link as `file` and its destination, as written, as `target`; baselined or not, what a link points at is never read. A Nix `result` link inside a package is a finding; `ignore: ["**/result/**"]` clears it. The oxlint plugin reports it on each file oxlint reaches through a link and reads nothing else in that file.
- `unreadable-directory`: a directory the walk, a `workspaces` glob or a kind's glob cannot list (`EACCES`), unless the check skips it on purpose. 0.2 stopped with exit code 2 and the error instead.
- `directory-without-package`: a directory a root `workspaces` glob matches that has no `package.json` and lies neither inside nor above a member, so nothing checks its files; only the topmost of nested ones is reported, and a negated glob (`!tools/legacy` or `!tools/legacy/**`) leaves it out. No new configuration key: add `dir/**` to `ignore`, or baseline it, to keep one.

A workspaces entry that names a symbolic link literally is no longer a member: it is reported instead of followed. `listSourceFiles` no longer lists a file reached through a link; the new `walkSources` returns the files with the walk's findings. `Workspace` has a new field, `globs`, the root's `workspaces` globs.
