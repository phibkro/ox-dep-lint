---
"ox-dep-lint": minor
---

New policy `imports.typeOnly`. With `"as-values"`, shipped code's type-only imports are judged like value imports by `runtime-module`, `forbidden-external`, `undeclared-import` and `shipped-imports-development-file`, so `import type { Socket } from "bun"` fails in a kind with `runtimeModules: false` and a vendor's types fail where the kind's `externals` do not allow it. The default, `"relaxed"`, keeps 0.1's behaviour: types do not load, so those rules skip them.
