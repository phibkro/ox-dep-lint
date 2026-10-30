# ox-dep-lint

Module dependency graph rules for monorepos, as an [oxlint](https://oxc.rs/docs/guide/usage/linter) JS plugin and a CLI that share one engine. It declares the kinds of package a workspace has (libraries, services, platforms, apps, tools) and checks every import against them.

It is meant to sit beside two tools it does not repeat:

- [knip](https://knip.dev) for unused and unlisted packages, unresolved imports and binaries;
- oxlint's `import/no-cycle` for cycles between files.

ox-dep-lint replaces the hand-written module graph checks of three repositories by the same author (file-transfer, vektorprogrammet-reimagined and reebeat). Each copy had a gap another one closed.

## What it checks

| Rule                             | Finding                                                                                                                                                                                                                                                                                                                | Front end |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `forbidden-edge`                 | An import, re-export, `import()` or type-level `import()` of a workspace package that its kind (or its `uses`) does not allow. The same check runs on edges declared in `package.json`: all four dependency fields by default, devDependencies included.                                                               | both      |
| `type-only-edge`                 | A value import of a package listed in `typeOnlyUses`.                                                                                                                                                                                                                                                                  | both      |
| `unknown-workspace-package`      | A name under a workspace scope that no package has, in an import or a `package.json`.                                                                                                                                                                                                                                  | both      |
| `relative-import-leaves-package` | A relative path or alias that resolves into another package or out of the repository. Import a package by its name instead.                                                                                                                                                                                            | both      |
| `forbidden-external`             | An outside package that the kind's `externals` does not allow, in shipped code.                                                                                                                                                                                                                                        | both      |
| `runtime-module`                 | `node:*`, a bare Node built-in (`fs`), `bun`, `bun:*` or `cloudflare:*` in the shipped code of a kind with `runtimeModules: false`.                                                                                                                                                                                    | both      |
| `test-only-in-shipped`           | A `testOnlySpecifiers` match (`fast-check`, `vite-plus/test`) in shipped code.                                                                                                                                                                                                                                         | both      |
| `undeclared-import`              | A package that the file's own `package.json` does not declare. Shipped code needs `dependencies`, `peerDependencies` or `optionalDependencies`; development files may also use devDependencies and the root's. This covers what knip misses: files no entry reaches, and shipped code leaning on a root devDependency. | both      |
| `computed-import`                | `import(expression)`, an `import.meta.glob`, or a literal written with an escape sequence, whose text is not the module it loads. Shipped code only, by default.                                                                                                                                                       | both      |
| `unresolved-import`              | A relative path or alias (`#x`, `@/x`, `~/x`) that names no file.                                                                                                                                                                                                                                                      | both      |
| `self-import-by-name`            | A package importing itself by its own name (off by default).                                                                                                                                                                                                                                                           | both      |
| `package-without-kind`           | A workspace package that no kind's globs hold.                                                                                                                                                                                                                                                                         | both      |
| `package-cycle`                  | A cycle between packages through their runtime dependency fields.                                                                                                                                                                                                                                                      | CLI       |
| `stale-baseline`                 | A baseline entry that no finding needs any more, so the baseline can only shrink.                                                                                                                                                                                                                                      | CLI       |

Imports are read with oxc-parser and resolved with oxc-resolver, the same resolver oxlint uses: `tsconfig.json` `paths`, `package.json` `imports` and `exports`, `.js` for the `.ts` beside it, and symbolic links. Package names come from each `package.json`, never from directory names.

## Files: shipped, development, unchecked

The first matching file class decides how a file is checked. Globs in a class are relative to the file's package. Files that no class matches are shipped.

- **shipped:** every rule applies.
- **development:** kind edges, relative imports and unresolved imports are still checked. The file may use devDependencies (its own and the root's), test-only specifiers, runtime modules, any outside package and computed `import()`.
- **unchecked:** the file is not read.

By default, `test/**`, `tests/**`, `scripts/**`, `**/__tests__/**`, `**/fixtures/**` and `**/*.{test,spec,bench}.*` are development files. A package's `testSupportFiles` are development files too (a conformance suite's entry, for example).

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

| Policy               | Default            | Other values     |
| -------------------- | ------------------ | ---------------- |
| `computed`           | `error-in-shipped` | `error`, `allow` |
| `selfByName`         | `allow`            | `error`          |
| `unresolved`         | `error`            | `ignore`         |
| `manifestEdgeFields` | all four fields    | any subset       |
| `requireDeclared`    | `true`             | `false`          |

## Running it

The CLI checks every file that git tracks or would track (so ignored files are skipped), and runs the whole-graph checks too:

```sh
ox-dep-lint            # finds ox-dep-lint.config.{ts,mts,js,mjs,json} at the workspace root
ox-dep-lint --config path/to/config.ts --root path/to/workspace
```

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

The plugin and the CLI call one function per file, and a test runs both under real oxlint and requires the same findings at the same places.

## Not yet

- `import.meta.glob` patterns are reported as computed rather than read. vektorprogrammet-reimagined's closed glob grammar is the next thing to lift.
- Modules and layers inside a package, and restricted specifier groups with per-file allowances, are not in this version yet. vektorprogrammet-reimagined needs both.
- pnpm's `pnpm-workspace.yaml` is not read; the root `package.json` `workspaces` is.

## Licence

MIT. The specifier reader and resolver are adapted from phibkro/vektorprogrammet-reimagined, and the rules from that repository and phibkro/file-transfer, all by the same author. The escape-sequence rule closes a bypass found in reebeat/reebeat's tier check. No code from reebeat was copied.
