# Changelog

## 0.4.0

### Minor Changes

- e75db50: Sources under a workspace glob no longer escape the check unreported: each one is read, or the reason it cannot be read is a finding. Plain files at a glob's level (`packages/x.ts`, outside every package directory) and entries that are neither files, directories nor links (FIFOs, sockets) are still not reported. This can add findings to a repository that passed before, so upgrade with the CLI once and baseline or fix what it reports.

  - The walk now reads dot directories inside a package (`src/.internal/x.ts`), as oxlint already did; it skips only `node_modules` and `.git`.
  - `output` now defaults to `dist/**`, `coverage/**` and the caches tools write at a package root: `.wrangler/**`, `.astro/**`, `.svelte-kit/**`, `.next/**`, `.turbo/**`, `.vercel/**`, `.nuxt/**`, `.output/**`. Setting `output` replaces the defaults; it does not add to them.
  - `symbolic-link`: every symbolic link under a package directory, whatever it points at and whatever its name (`.d.ts`, `.md`, `.json`, extensionless); a link a `workspaces` or kind glob matches or names literally; and a link a glob passes through (`packages` itself a link). Links are never followed: 0.2 read a link to a file as if it were the file, skipped a link to a directory silently, and followed a linked `packages`. Only links inside directories the check skips on purpose are not reported: `node_modules`, `.git`, and directories that `ignore`, `output` or an unchecked file class cover through a trailing `/**`. A baseline entry names the link as `file` and its destination, as written, as `target`; baselined or not, what a link points at is never read. A Nix `result` link inside a package is a finding; `ignore: ["**/result/**"]` clears it. The oxlint plugin reports it on each file oxlint reaches through a link and reads nothing else in that file.
  - `unreadable-path`: a directory the walk, a `workspaces` glob or a kind's glob cannot list, or a source file the check cannot read (`EACCES`), unless the check skips it on purpose. 0.2 stopped with exit code 2 and the error instead.
  - `directory-without-package`: a directory a root `workspaces` glob matches that has no `package.json` and lies neither inside nor above a member, so nothing checks its files; and a dot directory such a glob would match (`packages/.template`), with or without a `package.json`, since npm and Bun workspaces never match dot directories. Only the topmost of nested ones is reported, and a negated glob (`!tools/legacy` or `!tools/legacy/**`) leaves it out. No new configuration key: add `dir/**` to `ignore`, or baseline it, to keep one.

  A workspaces entry or kind glob that names or passes through a symbolic link no longer finds packages there: the link is reported instead of followed. `listSourceFiles` no longer lists a file reached through a link; the new `walkSources` returns the files with the walk's findings. `Workspace` has a new field, `globs`, the root's `workspaces` globs.

## 0.3.0

### Minor Changes

- 7af0fef: An internal refactor with no change in behaviour for configurations written as plain data (objects, arrays and strings, without getters, Proxies or custom iterators): every finding and every message is the same as in 0.2.0, in the same order, and so is every configuration error. Output differs only where 0.2.0 crashed: a hole in a sparse `fileClasses` or `baseline` list (`[ , ]` in an `.mjs` file) is now reported as `fileClasses must be a list of objects` or `baseline must be a list of objects`, also when a Symbol elsewhere would have crashed first; and a chain of thousands of packages, which exhausted 0.2.0's stack, is now checked. A Symbol written into a message (a baseline entry's file, a kind in `mayUse`) still crashes (exit 2) when no such hole is present, though the TypeError's wording can differ when another value that cannot become a string (an object without a usable `toString`) is also present, because the checks run in another order. A configuration built from getters, Proxies or custom iterators can now be read differently, because validation reads values (including those of unknown keys) that 0.2.0 never read.

  The configuration is validated by valibot schemas whose issues map to 0.2's messages, cycles between packages come from Tarjan's strongly connected components (iterative, so a long chain of packages cannot exhaust the stack) with the same routes as before, and the walk through development files reads its queue from a head index instead of `shift()`.

  New runtime dependency: `valibot` 1.5.0 (MIT). The public types are unchanged and written out as before; the emitted declarations do not import valibot.

## 0.2.0

### Minor Changes

- 89ab407: New policy `imports.typeOnly`. With `"as-values"`, shipped code's type-only imports (every form, `/// <reference types>` included) are judged by `runtime-module`, `forbidden-external`, `undeclared-import` and `shipped-imports-development-file`. So `import type { Socket } from "bun"` fails in a kind with `runtimeModules: false`, and a vendor's types fail where the kind's `externals` do not allow it. A shipped `@types/x` still declares `x` for a type-only import. The default, `"relaxed"`, keeps 0.1's behaviour: types do not load, so those rules skip them.

  A runtime's own types package (`node`, `@types/node`, `bun-types`, `@types/bun`, `@cloudflare/workers-types`, or a subpath of one) used type-only now counts as that runtime, in shipped and development files alike. So it is never reported as an outside package or as undeclared; until now an undeclared one gave `undeclared-import`. Under `"as-values"`, `runtime-module` judges it where the kind allows no runtime modules; under `"relaxed"` it passes, like other type-only imports.

## 0.1.1

- 0.1.0 was published without its built `dist` files, so neither the CLI nor the plugin could load. A `prepack` script now builds before every pack and publish, so a package cannot go out without them. Use 0.1.1.
- The `bin` path is written as npm stores it (`dist/cli.mjs`), so publishing no longer warns that it was corrected.
- First release published from GitHub Actions through npm trusted publishing, with provenance.

## 0.1.0

- First release: the oxlint plugin `dep-lint/imports` and the `ox-dep-lint` CLI, sharing one engine. See the README for the rules, the configuration and what is not covered yet.
