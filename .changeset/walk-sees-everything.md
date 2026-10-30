---
"ox-dep-lint": minor
---

Three new findings make sure no source escapes the check unreported. They can add findings to a repository that passed before, so upgrade with the CLI once and baseline or fix what it reports.

- `symbolic-link`: a symbolic link where the check would read (a link to a source file it reads, or a link to a directory, a dangling link or a cycle under a directory it does not skip), and a link a `workspaces` glob matches. Links are never followed now: 0.2 read a link to a file as if it were the file and skipped a link to a directory silently. A link to a non-source file, and links under `node_modules`, dot directories and directories that `ignore`, `output` or an unchecked file class cover through a trailing `/**`, are not reported. The oxlint plugin reports it on each file oxlint reaches through a link and reads nothing else in that file. A baseline entry names the link as `file` and its destination, as written, as `target`.
- `unreadable-directory`: a directory the walk or a `workspaces` glob cannot list (`EACCES`), unless the check would read nothing in it. 0.2 stopped with exit code 2 and the error instead.
- `directory-without-package`: a directory a root `workspaces` glob matches that has no `package.json` and lies neither inside nor above a member, so nothing checks its files. No new configuration key: add `dir/**` to `ignore`, or baseline it, to keep one.

`listSourceFiles` no longer lists a file reached through a link; the new `walkSources` returns the files with the walk's findings. `Workspace` has a new field, `globs`, the root's `workspaces` globs.
