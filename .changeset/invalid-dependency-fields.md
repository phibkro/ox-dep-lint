---
"ox-dep-lint": minor
---

`invalid-package` now reports a workspace member whose `dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies` is not an object: a string (`"dependencies": "some string"`), a list, a number, a boolean or `null`. 0.4 read no names from such a field and said nothing, so a forbidden or undeclared edge written there passed unseen. The finding names the field and what it holds, once per field; the member is still checked, as if that field declared nothing. The root `package.json` is not judged this way.

This is a minor release rather than a patch because it can fail a check that passed on 0.4 (the README's rule: before 1.0, a change to what the rules report is a minor bump). Fix the field, or baseline the finding with `file` set to the member's `package.json`, `rule: "invalid-package"` and `target` set to its directory.
