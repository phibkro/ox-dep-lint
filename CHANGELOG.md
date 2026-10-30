# Changelog

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
