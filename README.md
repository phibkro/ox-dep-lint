# ox-dep-lint

Module dependency graph rules for monorepos, as an [oxlint](https://oxc.rs/docs/guide/usage/linter) JS plugin and a CLI that share one engine. It declares the kinds of package a workspace has (libraries, services, platforms, apps, tools) and checks every import against them.

It is meant to sit beside two tools it does not repeat:

- [knip](https://knip.dev) for unused and unlisted packages, unresolved imports and binaries;
- oxlint's `import/no-cycle` for cycles between files.

ox-dep-lint replaces the hand-written module graph checks of three repositories by the same author (file-transfer, vektorprogrammet-reimagined and reebeat). Each copy had a gap another one closed.

## What it checks

| Rule                               | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Front end                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `forbidden-edge`                   | A load of a workspace package that its kind (or its `uses`) does not allow. The same check runs on edges declared in `package.json`: all four dependency fields by default, devDependencies included.                                                                                                                                                                                                                                                                                                                                                                                       | both                                                         |
| `type-only-edge`                   | A value import of a package listed in `typeOnlyUses`. Only `import type` and `export type` declarations are type-only; an inline `import { type X }` still loads the module under `verbatimModuleSyntax`.                                                                                                                                                                                                                                                                                                                                                                                   | both                                                         |
| `unknown-workspace-package`        | A name under a workspace scope that no package has, in an import or a `package.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | both                                                         |
| `package-path-escape`              | A package specifier with `.` or `..` after the name (`@acme/a/../b/src/x.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | both                                                         |
| `relative-import-leaves-package`   | A relative path, alias, root-absolute path or worker URL that resolves into another package, into `node_modules` or out of the repository. Import a package by its name instead.                                                                                                                                                                                                                                                                                                                                                                                                            | both                                                         |
| `shipped-imports-development-file` | Shipped code importing a development file (of its own package, or one another package exports), or a file under `output` or `ignore`, that would not pass as shipped code itself: a test helper using `fast-check`, a script using `node:fs`. A development file that would pass, such as a shared helper under `scripts/`, may be imported.                                                                                                                                                                                                                                                | both                                                         |
| `forbidden-external`               | An outside package that the kind's `externals` does not allow, in shipped code or in `package.json`'s shipped fields. An outside package is named by the package it installs (the `name` in its installed `package.json`, or an `npm:` alias's target), so an alias cannot pass one package off as another; `externals` name real packages.                                                                                                                                                                                                                                                 | both, `package.json` in the CLI                              |
| `runtime-module`                   | `node:*`, a bare Node built-in (`fs`), `bun`, `bun:*` or `cloudflare:*`, also when a package import (`#crypto`) maps to one, in the shipped code of a kind with `runtimeModules: false`.                                                                                                                                                                                                                                                                                                                                                                                                    | both                                                         |
| `test-only-in-shipped`             | A `testOnlySpecifiers` match (`fast-check`, `vite-plus/test`) in shipped code, with any `?query` stripped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | both                                                         |
| `undeclared-import`                | A package the file's own `package.json` does not declare. Shipped code needs `dependencies`, `peerDependencies` or `optionalDependencies` (`imports.shippedFields`); type-only imports and development files may also use devDependencies and the root's. This covers what knip misses: files no entry reaches, and shipped code leaning on a root devDependency.                                                                                                                                                                                                                           | both                                                         |
| `computed-import`                  | A load whose module the check cannot read: `import(expression)`, `require(expression)`, `import.meta.glob`, a kept `createRequire` function, or a literal written with an escape sequence (which is also checked by the module it spells). Shipped code only, by default.                                                                                                                                                                                                                                                                                                                   | both                                                         |
| `unresolved-import`                | A relative path or alias (`#x`, `@/x`, `~/x`) that names no file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | both                                                         |
| `self-import-by-name`              | A package importing itself by its own name (off by default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | both                                                         |
| `package-without-kind`             | A workspace package that no kind's globs hold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | both                                                         |
| `package-outside-workspace`        | A directory a kind names, with a `package.json`, that the root `workspaces` leave out, so nothing in it would be checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | CLI                                                          |
| `invalid-package`                  | A workspace member whose `package.json` cannot be read, has no name, or has another member's name; or one with a dependency field (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`) that is not an object (`"dependencies": "x"`, a list, a number, `null`), so no edge in it could be read. Such a member is still checked, as if that field declared nothing.                                                                                                                                                                                               | CLI                                                          |
| `directory-without-package`        | A directory a root `workspaces` glob matches that has no `package.json` and lies neither inside nor above a member, so no package owns its files and nothing checks them (tsukuri's "directory in no tier"). Also a dot directory such a glob would match (`packages/.template`), with or without a `package.json`: npm and Bun workspaces never match dot directories, so it is no package. Only the topmost of nested ones is reported; a negated glob (`!tools/legacy` or `!tools/legacy/**`) leaves the directory out. Silence one with `ignore` (`tools/vendored/**`) or the baseline. | CLI                                                          |
| `symbolic-link`                    | Every symbolic link under a package directory, whatever it points at (a file, a directory, nothing, a cycle) and whatever its name (`.d.ts`, `.md`, `.json`, extensionless); a link a `workspaces` or kind glob matches or names (`packages/x -> ../elsewhere`); and a link a glob passes through (`packages` itself a link). The check never follows one. It skips only links inside directories it skips on purpose: `node_modules`, `.git`, and directories `ignore`, `output` or an unchecked file class cover through a trailing `/**`.                                                | both (the plugin on each file oxlint reaches through a link) |
| `unreadable-path`                  | A directory the walk, a `workspaces` glob or a kind glob cannot list, or a source file the check cannot read (`EACCES`), unless the check skips it on purpose. It used to stop the check with exit code 2. A path removed while the check runs (`ENOENT`, or `ENOTDIR` when a directory on the way became a file), such as a test's temporary tree, is skipped with no finding.                                                                                                                                                                                                             | CLI                                                          |
| `package-cycle`                    | A cycle between packages through their runtime dependency fields.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | CLI                                                          |
| `stale-baseline`                   | A baseline entry that no finding needs any more, so the baseline can only shrink.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | CLI                                                          |
| `parse-error`                      | A file that does not parse, so its imports cannot be checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | both                                                         |

A load is any of: `import` and `export ... from` (static, `defer` and `source` phases), `import()`, a type-level `import("...")`, `import x = require("...")`, a string-named `declare module "..."`, `/// <reference types="..." />`, `require`, `require.resolve`, `module.require`, `import.meta.require`, `import.meta.resolve`, `process.getBuiltinModule`, `createRequire(...)("...")`, and a `new URL("...", import.meta.url)` passed to `new Worker`, `new SharedWorker` or `navigator.serviceWorker.register` (bundlers load it as a module, extension or not; any other `new URL` locates a file to read or an asset to serve, and is not a load). `require.resolve` and `import.meta.resolve` with a literal are edges; with an expression they load nothing.

## Files: shipped, development, unchecked

The first matching file class decides how a file is checked. Globs in a class are relative to the file's package. Files that no class matches are shipped.

- **shipped:** every rule applies.
- **development:** kind edges, relative imports and unresolved imports are still checked. The file may use devDependencies (its own and the root's), test-only specifiers, runtime modules, any outside package and computed `import()`.
- **unchecked:** the file is not read.

By default, `test/**`, `tests/**`, `e2e/**`, `scripts/**`, package-root `*.config.*`, `**/__tests__/**`, `**/fixtures/**` and `**/*.{test,spec,bench}.*` are development files. A package's build output and the caches tools write at its root are not read: `output` defaults to `dist/**`, `coverage/**`, `.wrangler/**`, `.astro/**`, `.svelte-kit/**`, `.next/**`, `.turbo/**`, `.vercel/**`, `.nuxt/**` and `.output/**`. Setting `output` replaces these defaults rather than adding to them, so list the ones you still want (`[]` reads everything). Shipped code that imports a file under `output` still has that file judged. A package's `testSupportFiles` are development files too (a conformance suite's entry, for example).

## Configuration

```ts
// ox-dep-lint.config.ts
import { defineConfig } from "ox-dep-lint"

export default defineConfig({
  workspaceScopes: ["@acme/"],
  kinds: {
    library: { packages: ["libraries/*"], mayUse: ["library"], externals: ["effect"], runtimeModules: false },
    service: { packages: ["services/*"], mayUse: ["library"], externals: ["effect"], runtimeModules: false },
    platform: { packages: ["platforms/*"], mayUse: ["service", "library"] },
    app: { packages: ["apps/*"], mayUse: ["library"] },
    tool: { packages: ["tools/*"], mayUse: "any" },
  },
  packages: {
    "@acme/conformance": { testSupportFiles: ["src/index.ts"] },
    "@acme/web": { typeOnlyUses: ["@acme/service-room"] },
  },
  testOnlySpecifiers: ["vite-plus/test", "fast-check", "@acme/conformance"],
  baseline: [{ file: "apps/web/src/legacy.ts", rule: "forbidden-edge", target: "@acme/service-room", reason: "moves behind the client library in stage 2" }],
})
```

A kind may use its own kind only when `mayUse` lists it. `imports` holds the policies where repositories differ:

| Policy               | Default                                                    | Other values     |
| -------------------- | ---------------------------------------------------------- | ---------------- |
| `computed`           | `error-in-shipped`                                         | `error`, `allow` |
| `selfByName`         | `allow`                                                    | `error`          |
| `unresolved`         | `error`                                                    | `ignore`         |
| `manifestEdgeFields` | all four fields                                            | any subset       |
| `requireDeclared`    | `true`                                                     | `false`          |
| `shippedFields`      | `dependencies`, `peerDependencies`, `optionalDependencies` | any subset       |
| `typeOnly`           | `relaxed`                                                  | `as-values`      |

`typeOnly: "as-values"` judges shipped code's type-only imports (`import type`, `export type`, type-level `import()`, `declare module`, `import type X = require()`, `/// <reference types>`) by `runtime-module`, `forbidden-external`, `undeclared-import` and `shipped-imports-development-file`, so `import type { Socket } from "bun"` fails in a kind without runtime modules. Two differences from value imports remain. A shipped field that declares `@types/x` declares `x` for a type-only import, and such an `@types/x` is an outside package too, so `externals` lists both. A runtime's own types package (`node` or `@types/node`, `bun`, `bun-types` or `@types/bun`, `@cloudflare/workers-types`) counts as that runtime, so it is judged by `runtime-module` and never needs declaring. That includes a published package whose emitted declarations reference those types: declare `@types/node` or `bun-types` for its consumers yourself; this check does not ask for it. By default types do not load, so those rules skip type-only imports. Kind edges and `typeOnlyUses` always see the real form.

Misspelled keys, unknown policies and baseline entries without a `target` are configuration errors, never silent defaults.

The root `workspaces` globs also say where packages live: a directory they match without a `package.json` is a `directory-without-package` finding, so no new key is needed. To keep such a directory (vendored sources that are not a package), add `dir/**` to `ignore` or baseline it with `file` and `target` both set to the directory.

A `symbolic-link` baseline entry names the link as `file` and its destination, as the link writes it, as `target`, so pointing the link elsewhere makes the entry stale. Baselining a link does not make the check read through it: what a link points at is never read, baselined or not. A Nix `result` link (from `nix build`) left inside a package is a finding too; build outside packages, or add `**/result/**` to `ignore`.

## Installing

```sh
bun add --dev ox-dep-lint   # or npm install --save-dev ox-dep-lint
```

Releases are published from a `v*` tag by `.github/workflows/release.yml`, with npm provenance.

## Running it

The CLI walks every workspace package's directory, dot directories included (`src/.internal/`), skipping only `node_modules` and `.git` and reading nothing under `output`, so generated and gitignored sources and nested repositories are checked too, and runs the whole-graph checks. Tool caches such as `.wrangler` and `.astro` are in the default `output`; for another cache, set `output` to the defaults plus its glob, since `output` replaces the defaults. The CLI never follows a symbolic link: every link is a `symbolic-link` finding, and a directory it cannot list or a file it cannot read is an `unreadable-path` finding; one that disappears between being listed and being read is skipped. What it still does not report: plain files directly at a workspace glob's level (`packages/x.ts`), and FIFOs and sockets.

```sh
ox-dep-lint            # finds ox-dep-lint.config.{ts,mts,js,mjs,json} at the workspace root
ox-dep-lint --config path/to/config.ts --root path/to/workspace
```

The workspace root for a file is the nearest directory whose `package.json` `workspaces` hold that file, else the nearest with any `workspaces`. A worktree kept inside another checkout is checked as itself, and a git submodule listed as a member still belongs to the workspace that lists it.

The oxlint plugin reports the per-file findings in the editor and in `oxlint` / `vp lint`. It takes the same configuration as the option of its one rule:

```ts
// vite.config.ts (Vite+) or oxlint.config.ts
import depLint from "./ox-dep-lint.config.ts"

export default defineConfig({
  lint: {
    jsPlugins: ["ox-dep-lint/plugin"],
    rules: { "dep-lint/imports": ["error", depLint] },
  },
})
```

The plugin and the CLI call one function per file, and a test runs both under real oxlint and requires the same findings at the same places. In a long-lived process (an editor's language server) the plugin rebuilds its view of the workspace when a `package.json` changes, and looks again for a file it could not resolve.

Where they can still differ: oxlint chooses which files it lints (its own ignores), and the CLI reads the files of workspace packages. oxlint follows symbolic links, so the plugin reports `symbolic-link` at line 1 of each file it is given through a link (and reads nothing else in it), where the CLI reports the link once; a link to a file oxlint does not lint (`README.md`) is reported by the CLI alone. Both read dot directories. oxlint shows line-1 columns of a file that starts with a byte order mark three further on than the CLI does.

## Not yet

- `import.meta.glob` patterns are reported as computed rather than read. vektorprogrammet-reimagined's closed glob grammar is the next thing to lift.
- Modules and layers inside a package, and restricted specifier groups with per-file allowances, are not in this version yet. vektorprogrammet-reimagined needs both.
- pnpm's `pnpm-workspace.yaml` is not read; the root `package.json` `workspaces` is.
- `/// <reference path="..." />` and JSDoc `@import` types are not read.
- A `require` passed around as a value (`const load = require; load("x")`) is not followed. Telling the global loader from a local of the same name needs scope analysis; until then the check reads `require` only where it is called.

## Contributing and releases

- Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `chore:`); a `commit-msg` hook and CI check them with commitlint.
- Every pull request adds a changeset: `bunx changeset` and pick patch, minor or major, or `bunx changeset --empty` when nothing ships. Before 1.0, a breaking change is a minor bump.
- Versions follow [semantic versioning](https://semver.org/) and are never edited by hand. While changesets wait on main, the `release` workflow keeps a pull request `chore(release): vX.Y.Z` up to date with the bumped `package.json` and the new `CHANGELOG.md` entry. Merging it publishes that version to npm through trusted publishing (with provenance), tags it and makes a GitHub release. Empty changesets alone open no release; they are consumed with the next one.

## Licence

MIT. The specifier reader and resolver are adapted from phibkro/vektorprogrammet-reimagined, and the rules from that repository and phibkro/file-transfer, all by the same author. The escape-sequence rule closes a bypass found in reebeat/reebeat's tier check. No code from reebeat was copied.
