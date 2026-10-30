---
"ox-dep-lint": minor
---

An internal refactor with no change in behaviour for configurations written as plain data (objects, arrays and strings, without getters, Proxies or custom iterators): every finding and every message is the same as in 0.2.0, in the same order, and so is every configuration error. Output differs only where 0.2.0 crashed: a hole in a sparse `fileClasses` or `baseline` list (`[ , ]` in an `.mjs` file) is now reported as `fileClasses must be a list of objects` or `baseline must be a list of objects`, also when a Symbol elsewhere would have crashed first; and a chain of thousands of packages, which exhausted 0.2.0's stack, is now checked. A Symbol written into a message (a baseline entry's file, a kind in `mayUse`) still throws when no such hole is present. A configuration built from getters, Proxies or custom iterators can now be read differently, because validation reads values (including those of unknown keys) that 0.2.0 never read.

The configuration is validated by valibot schemas whose issues map to 0.2's messages, cycles between packages come from Tarjan's strongly connected components (iterative, so a long chain of packages cannot exhaust the stack) with the same routes as before, and the walk through development files reads its queue from a head index instead of `shift()`.

New runtime dependency: `valibot` 1.5.0 (MIT). The public types are unchanged and written out as before; the emitted declarations do not import valibot.
