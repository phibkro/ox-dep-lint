---
"ox-dep-lint": minor
---

New policy `imports.typeOnly`. With `"as-values"`, shipped code's type-only imports (every form, `/// <reference types>` included) are judged by `runtime-module`, `forbidden-external`, `undeclared-import` and `shipped-imports-development-file`. So `import type { Socket } from "bun"` fails in a kind with `runtimeModules: false`, and a vendor's types fail where the kind's `externals` do not allow it. A shipped `@types/x` still declares `x` for a type-only import. The default, `"relaxed"`, keeps 0.1's behaviour: types do not load, so those rules skip them.

A runtime's own types package (`node`, `@types/node`, `bun-types`, `@types/bun`, `@cloudflare/workers-types`, or a subpath of one) used type-only now counts as that runtime, in shipped and development files alike. So it is never reported as an outside package or as undeclared; until now an undeclared one gave `undeclared-import`. Under `"as-values"`, `runtime-module` judges it where the kind allows no runtime modules; under `"relaxed"` it passes, like other type-only imports.
