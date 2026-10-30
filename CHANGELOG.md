# Changelog

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
