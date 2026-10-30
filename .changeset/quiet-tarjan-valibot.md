---
"ox-dep-lint": minor
---

An internal refactor with no change in behaviour: every finding, every message and every configuration error is the same as in 0.2.0, in the same order. The configuration is validated by valibot schemas whose issues map to 0.2's messages, cycles between packages come from Tarjan's strongly connected components (iterative, so a long chain of packages cannot exhaust the stack) with the same routes as before, and the walk through development files reads its queue from a head index instead of `shift()`.

New runtime dependency: `valibot` 1.5.0 (MIT). The exported `Config` type is unchanged in shape; `FilePolicy`, `ManifestField`, `RuleName` and the import policies are now inferred from the schemas, so the emitted declarations import valibot's types.
