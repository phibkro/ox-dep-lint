---
"ox-dep-lint": minor
---

`invalid-package` now reports a workspace member whose `dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies` is not an object: a string (`"dependencies": "some string"`), a list, a number, a boolean or `null`. 0.4 read no names from such a field and said nothing, so a forbidden or undeclared edge written there passed unseen. The finding names the field and what it holds, once per field; the member is still checked, as if that field declared nothing. The root `package.json` is not judged this way.

This is a minor release rather than a patch because it can fail a check that passed on 0.4 (the rule in `.changeset/README.md`: before 1.0, a change to what the rules report is a minor bump). Fix the field, or baseline the finding by its own target, the member's directory and the field joined by `#`:

```ts
baseline: [{ file: "tools/quality/package.json", rule: "invalid-package", target: "tools/quality#peerDependencies", reason: "..." }]
```

Such an entry covers only that field. If the `package.json` later cannot be read or loses its name, which drops the member from the check, that is still reported, with the directory as its target.
