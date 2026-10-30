/**
 * Configuration errors that 0.3's valibot schemas must report as 0.2's hand-written checks did. Each expectation was
 * taken from the 0.2.0 sources, so a difference here is a change in behaviour.
 */
import { describe, expect, it } from "vite-plus/test"
import type { Config } from "../src/config.ts"
import { configProblems } from "../src/config.ts"

const base = { workspaceScopes: ["@acme/"], kinds: { a: { packages: ["libraries/*"], mayUse: ["a"] } } }

/** `items` and then one hole: a sparse list, as an `.mjs` configuration writes it with `["x", , ]`. */
const withHole = (...items: unknown[]): unknown[] => {
  const list = [...items]
  list.length = items.length + 1

  return list
}

// SAFETY: deliberately not a Config, to see what validation says about it.
const problems = (config: object) => configProblems(config as Config)

describe("sparse lists, whose holes 0.2 skipped with every()", () => {
  const listKeys: Record<string, object> = {
    workspaceScopes: { ...base, workspaceScopes: withHole("@acme/") },
    "a kind's packages": { ...base, kinds: { a: { packages: withHole("libraries/*"), mayUse: ["a"] } } },
    "a kind's externals": { ...base, kinds: { a: { packages: ["libraries/*"], mayUse: ["a"], externals: withHole("effect") } } },
    "file class files": { ...base, fileClasses: [{ files: withHole("test/**"), policy: "development" }] },
    ...Object.fromEntries(
      ["uses", "externals", "typeOnlyUses", "valueSpecifiers", "testSupportFiles"].map((key) => [
        `a package's ${key}`,
        { ...base, packages: { "@acme/a": { [key]: withHole("x") } } },
      ]),
    ),
    ...Object.fromEntries(["prefixes", "names"].map((key) => [`runtimeModules.${key}`, { ...base, runtimeModules: { [key]: withHole("node:") } }])),
    ...Object.fromEntries(["virtualModules", "testOnlySpecifiers", "ignore", "output"].map((key) => [key, { ...base, [key]: withHole("x") }])),
    ...Object.fromEntries(["manifestEdgeFields", "shippedFields"].map((key) => [`imports.${key}`, { ...base, imports: { [key]: withHole("dependencies") } }])),
  }

  for (const [where, config] of Object.entries(listKeys)) {
    it(`accepts a hole in ${where}`, () => {
      expect(problems(config)).toEqual([])
    })
  }

  it("reads a hole in mayUse as undefined, as 0.2's for...of did", () => {
    expect(problems({ ...base, kinds: { a: { packages: ["libraries/*"], mayUse: withHole("a") } } })).toEqual(["kind a may use undefined, which is not a kind"])
  })

  it("reports a hole in fileClasses or baseline, where 0.2 crashed", () => {
    expect(problems({ ...base, fileClasses: withHole() })).toEqual(["fileClasses must be a list of objects"])
    expect(problems({ ...base, baseline: withHole() })).toEqual(["baseline must be a list of objects"])
    // When the outline fails for another reason, 0.2 returned before reaching the hole.
    expect(problems({ ...base, imports: 1, baseline: withHole() })).toEqual(["imports must be an object"])
  })
})

describe("Symbols, which 0.2 wrote into messages with template literals", () => {
  it("still throws for a Symbol as a baseline entry's file or as a kind it may use", () => {
    expect(() => problems({ ...base, baseline: [{ file: Symbol("file"), rule: "forbidden-edge", target: "x", reason: "r" }] })).toThrow(TypeError)
    expect(() => problems({ ...base, kinds: { a: { packages: ["x"], mayUse: [Symbol("kind")] } } })).toThrow(TypeError)
    expect(() => problems({ ...base, baseline: [{ file: "f", rule: Symbol("rule"), reason: "r" }] })).toThrow(TypeError)
  })

  it("names a Symbol rule with String where 0.2 did", () => {
    expect(problems({ ...base, baseline: [{ file: "f", rule: Symbol("rule"), target: "x", reason: "r" }] })).toEqual([
      "the baseline entry for f names the unknown rule Symbol(rule)",
    ])
  })
})
