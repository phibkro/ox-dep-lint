import { builtinModules } from "node:module"
import * as v from "valibot"

/**
 * How a file is checked. `shipped`: every rule. `development` (tests, scripts, fixtures): kind edges, relative imports
 * and unresolved imports are still checked, but devDependencies, test-only specifiers, runtime modules, outside
 * packages and computed `import()` are allowed. `unchecked`: not read at all.
 */
export type FilePolicy = "shipped" | "development" | "unchecked"

/** One kind of package (a layer of the workspace): which packages it holds and what they may import. */
export interface KindRule {
  /** Globs over package directories, relative to the repository root (`libraries/*`, `packages/core`). */
  readonly packages: readonly string[]
  /** Kinds whose packages this kind may import, its own included only when listed; `"any"` for tools. */
  readonly mayUse: readonly string[] | "any"
  /** Outside packages shipped code may import and `package.json` may name in `dependencies`, or `"any"`. Default `"any"`. */
  readonly externals?: readonly string[] | "any"
  /** Whether shipped code may import runtime modules (`node:fs`, `fs`, `bun`, `cloudflare:workers`). Default true. */
  readonly runtimeModules?: boolean
}

/** Refinements for one package, keyed by its name. */
export interface PackageRule {
  /** The workspace packages it may import, a subset of what its kind allows. */
  readonly uses?: readonly string[]
  /** Outside packages beyond its kind's. */
  readonly externals?: readonly string[]
  /** Workspace packages it may import only with `import type`, `export type` or a type-level `import()`. */
  readonly typeOnlyUses?: readonly string[]
  /** Globs over specifiers of a `typeOnlyUses` package that may still be imported as values (`@acme/core/steps`). */
  readonly valueSpecifiers?: readonly string[]
  /** Package-relative globs of files checked as development files though they ship (a conformance suite's entry). */
  readonly testSupportFiles?: readonly string[]
}

/** Files of one policy, by package-relative globs. The first class that matches a file wins; others are shipped. */
export interface FileClass {
  readonly files: readonly string[]
  readonly policy: FilePolicy
}

export const ruleNames = [
  "unknown-workspace-package",
  "package-without-kind",
  "package-outside-workspace",
  "directory-without-package",
  "invalid-package",
  "symbolic-link",
  "unreadable-directory",
  "forbidden-edge",
  "type-only-edge",
  "relative-import-leaves-package",
  "package-path-escape",
  "shipped-imports-development-file",
  "self-import-by-name",
  "forbidden-external",
  "runtime-module",
  "test-only-in-shipped",
  "undeclared-import",
  "computed-import",
  "unresolved-import",
  "package-cycle",
  "stale-baseline",
  "parse-error",
] as const

export type RuleName = (typeof ruleNames)[number]

/** A finding the repository tolerates for now. The check fails when no finding needs it any more, so the list shrinks. */
export interface BaselineEntry {
  /** Repository-relative file (or `package.json` path for a manifest finding). */
  readonly file: string
  readonly rule: RuleName
  /** The specifier or package the finding names. */
  readonly target: string
  readonly reason: string
}

export type ManifestField = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies"

export interface ImportPolicy {
  /** `import(expression)`, an escaped literal, `createRequire`: an error in shipped code (default), everywhere, or never. */
  readonly computed?: "error-in-shipped" | "error" | "allow"
  /** A package importing itself by its own name. Default `"allow"`. */
  readonly selfByName?: "error" | "allow"
  /** A relative path or alias that names no file. Default `"error"`. */
  readonly unresolved?: "error" | "ignore"
  /** Which `package.json` fields count as edges between workspace packages. Default all four. */
  readonly manifestEdgeFields?: readonly ManifestField[]
  /**
   * Every package a file imports must be declared in its own `package.json`. Shipped code needs `dependencies`,
   * `peerDependencies` or `optionalDependencies` (`shippedFields`); a type-only import and a development file may also
   * use devDependencies and the root's. Default true. knip's `unlisted` misses files no entry reaches and root
   * devDependencies used by shipped code.
   */
  readonly requireDeclared?: boolean
  /** The fields that satisfy a shipped import. Default `dependencies`, `peerDependencies`, `optionalDependencies`. */
  readonly shippedFields?: readonly ManifestField[]
  /**
   * How shipped code's type-only imports (`import type`, `export type`, a type-level `import()`, `declare module`, a
   * types reference) are judged by `runtime-module`, `forbidden-external`, `undeclared-import` and
   * `shipped-imports-development-file`. `"relaxed"` (default): types do not load, so those rules skip them and
   * devDependencies declare them. `"as-values"`: judged like value imports, for kinds whose public types must not name
   * a runtime or vendor either. Kind edges and `typeOnlyUses` always see the real form.
   */
  readonly typeOnly?: "relaxed" | "as-values"
}

export interface Config {
  /** Scopes whose specifiers must name a workspace package (`@file-transfer/`). */
  readonly workspaceScopes: readonly string[]
  readonly kinds: Readonly<Record<string, KindRule>>
  readonly packages?: Readonly<Record<string, PackageRule>>
  /** Default: tests, scripts and fixtures are development files. */
  readonly fileClasses?: readonly FileClass[]
  /** Default: `node:`, `bun:`, `cloudflare:` prefixes and every bare Node built-in plus `bun`. */
  readonly runtimeModules?: { readonly prefixes?: readonly string[]; readonly names?: readonly string[] }
  /** Prefixes of a bundler's virtual modules, which have nothing on disk to check. Default `virtual:`, `astro:`. */
  readonly virtualModules?: readonly string[]
  /** Globs over specifiers only development files may import: `fast-check` is that specifier alone, `fast-check/**` its subpaths. */
  readonly testOnlySpecifiers?: readonly string[]
  readonly imports?: ImportPolicy
  readonly baseline?: readonly BaselineEntry[]
  /** Repository-relative globs of files never read. */
  readonly ignore?: readonly string[]
  /** Package-relative globs of build output, never read. Default `dist/**` and `coverage/**`; `[]` reads everything. */
  readonly output?: readonly string[]
}

/** The configuration with every default filled in. */
export interface ResolvedConfig {
  readonly workspaceScopes: readonly string[]
  readonly kinds: Readonly<Record<string, Required<KindRule>>>
  readonly packages: Readonly<Record<string, PackageRule>>
  readonly fileClasses: readonly FileClass[]
  readonly runtimePrefixes: readonly string[]
  readonly runtimeNames: ReadonlySet<string>
  readonly virtualPrefixes: readonly string[]
  readonly testOnlySpecifiers: readonly string[]
  readonly imports: Required<ImportPolicy>
  readonly baseline: readonly BaselineEntry[]
  readonly ignore: readonly string[]
  readonly output: readonly string[]
}

export const defaultFileClasses: readonly FileClass[] = [
  {
    files: ["test/**", "tests/**", "e2e/**", "scripts/**", "*.config.*", "**/__tests__/**", "**/fixtures/**", "**/*.test.*", "**/*.spec.*", "**/*.bench.*"],
    policy: "development",
  },
]

/** Build output and coverage reports under a package, never read unless `output` says otherwise. */
export const defaultOutput: readonly string[] = ["dist/**", "coverage/**"]

const allManifestFields: readonly ManifestField[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]

/** Identity, for type checking a configuration file. */
export const defineConfig = (config: Config): Config => config

/*
 * Validation. The schemas say what a configuration may hold; `configProblems` turns their issues into the messages
 * 0.2 wrote, in 0.2's order, so a configuration that failed before fails with the same words. A misspelled key is a
 * problem, never a silent default.
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const plainObject = v.custom<Record<string, unknown>>(isPlainObject)

/**
 * Whether two types are the same, not merely assignable. The public types are written out by hand, so the emitted
 * declarations never name valibot; `schemaOf` ties each one to its schema at compile time instead.
 */
type Same<Left, Right> = (<Probe>() => Probe extends Left ? 1 : 2) extends <Probe>() => Probe extends Right ? 1 : 2 ? true : false

/** `schema` itself, which fails to type check unless it accepts exactly `Output`. */
const schemaOf =
  <Output>() =>
  <Schema extends v.GenericSchema>(schema: Schema & (Same<v.InferOutput<Schema>, Output> extends true ? unknown : never)): Schema =>
    schema

const filePolicySchema = schemaOf<FilePolicy>()(v.picklist(["shipped", "development", "unchecked"]))
const manifestFieldSchema = schemaOf<ManifestField>()(v.picklist(allManifestFields))
const ruleNameSchema = schemaOf<RuleName>()(v.picklist(ruleNames))

/** The values each import policy may take. */
const policies = {
  computed: schemaOf<NonNullable<ImportPolicy["computed"]>>()(v.picklist(["error-in-shipped", "error", "allow"])),
  selfByName: schemaOf<NonNullable<ImportPolicy["selfByName"]>>()(v.picklist(["error", "allow"])),
  unresolved: schemaOf<NonNullable<ImportPolicy["unresolved"]>>()(v.picklist(["error", "ignore"])),
  requireDeclared: schemaOf<NonNullable<ImportPolicy["requireDeclared"]>>()(v.boolean()),
  typeOnly: schemaOf<NonNullable<ImportPolicy["typeOnly"]>>()(v.picklist(["relaxed", "as-values"])),
}

/** 0.2's test for a list of strings. `every` skips the holes of a sparse array, where `v.array` reads `undefined`. */
const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string")

const stringList = v.custom<readonly string[]>(isStringList)

/** A list of manifest fields, holes skipped as in 0.2. */
const manifestFieldList = v.custom<readonly ManifestField[]>((value) => isStringList(value) && value.every((field) => v.is(manifestFieldSchema, field)))

/**
 * A value in a message, written as 0.2 wrote it: a template literal, which throws for a Symbol. 0.2 threw that way
 * (exit 2 with the TypeError's message), so the check still does.
 */
// SAFETY: the cast only satisfies the template's type; the conversion is the template's own, as in 0.2.
const asText = (value: unknown): string => `${value as string}`

/**
 * Every own entry of an object, each value checked by `value`. Not `v.record`, which skips the keys `constructor`,
 * `prototype` and `__proto__` that 0.2 checked. In an issue's path, the entry is its index and then 1.
 */
const ownEntries = <Value extends v.GenericSchema>(value: Value) =>
  v.pipe(
    plainObject,
    v.transform((input) => Object.entries(input)),
    v.array(v.tuple([v.string(), value])),
  )

/** 0.2's outline test for a list of objects, which skips holes as `every` does. */
const objectList = v.custom<readonly Record<string, unknown>[]>((value) => Array.isArray(value) && value.every(isPlainObject))

/** The outline (objects where objects belong, lists where lists belong), checked first: nothing else is read until it holds. */
const outlineSchema = v.pipe(
  plainObject,
  v.looseObject({
    kinds: ownEntries(plainObject),
    packages: v.optional(ownEntries(plainObject)),
    imports: v.optional(plainObject),
    runtimeModules: v.optional(plainObject),
    fileClasses: v.optional(objectList),
    baseline: v.optional(objectList),
  }),
)

const kindRuleSchema = v.strictObject({
  // A non-empty list; 0.2 left its items unchecked.
  packages: v.pipe(v.array(v.unknown()), v.minLength(1)),
  mayUse: v.union([v.literal("any"), stringList]),
  externals: v.optional(v.union([v.literal("any"), stringList])),
  runtimeModules: v.optional(v.boolean()),
})

// Here a key that is present must hold a list, even when its value is undefined; `unknownListProblems` checks the
// values of unknown keys as well, as 0.2 did.
const packageRuleSchema = v.strictObject({
  uses: v.exactOptional(stringList),
  externals: v.exactOptional(stringList),
  typeOnlyUses: v.exactOptional(stringList),
  valueSpecifiers: v.exactOptional(stringList),
  testSupportFiles: v.exactOptional(stringList),
})

const fileClassSchema = v.strictObject({ files: stringList, policy: filePolicySchema })

// As for a package's rule: a present key holds a list, and unknown keys' values are checked too.
const runtimeModulesSchema = v.strictObject({ prefixes: v.exactOptional(stringList), names: v.exactOptional(stringList) })

const importPolicySchema = v.strictObject({
  computed: v.optional(policies.computed),
  selfByName: v.optional(policies.selfByName),
  unresolved: v.optional(policies.unresolved),
  manifestEdgeFields: v.optional(manifestFieldList),
  requireDeclared: v.optional(policies.requireDeclared),
  shippedFields: v.optional(manifestFieldList),
  typeOnly: v.optional(policies.typeOnly),
})

const baselineEntrySchema = v.strictObject({
  // Not checked, as in 0.2, beyond being written into messages (where a Symbol throws, as it did in 0.2).
  file: v.optional(v.unknown()),
  rule: ruleNameSchema,
  target: v.pipe(v.string(), v.nonEmpty()),
  reason: v.pipe(
    v.string(),
    v.check((reason) => reason.trim() !== ""),
  ),
})

const configSchema = v.strictObject({
  workspaceScopes: stringList,
  kinds: ownEntries(kindRuleSchema),
  packages: v.optional(ownEntries(packageRuleSchema)),
  fileClasses: v.optional(v.array(fileClassSchema)),
  runtimeModules: v.optional(runtimeModulesSchema),
  virtualModules: v.optional(stringList),
  testOnlySpecifiers: v.optional(stringList),
  imports: v.optional(importPolicySchema),
  baseline: v.optional(v.array(baselineEntrySchema)),
  ignore: v.optional(stringList),
  output: v.optional(stringList),
})

/** One message and its place among the others: messages sort by `order`, and one `order` holds one message. */
interface Problem {
  readonly order: readonly number[]
  readonly message: string
}

/** The sections of the messages, in 0.2's order. */
const section = {
  configurationKeys: 0,
  kinds: 1,
  packages: 2,
  workspaceScopes: 3,
  testOnlySpecifiers: 4,
  virtualModules: 5,
  ignore: 6,
  output: 7,
  runtimeModuleValues: 8,
  importFields: 9,
  fileClasses: 10,
  runtimeModuleKeys: 11,
  importKeys: 12,
  importPolicies: 13,
  baseline: 14,
} as const

/** Within a kind: its unknown keys, then these fields, then the kinds it names that do not exist. */
const kindFieldOrder: readonly string[] = ["packages", "mayUse", "runtimeModules", "externals"]
const importFieldOrder: readonly string[] = ["manifestEdgeFields", "shippedFields"]
const importPolicyOrder: readonly string[] = ["computed", "selfByName", "unresolved", "requireDeclared", "typeOnly"]
const baselineFieldOrder: readonly string[] = ["file", "rule", "target", "reason"]

/** The values a policy may take, as its message lists them. */
const policyValues = (field: string): readonly unknown[] => {
  const schema = policies[field as keyof typeof policies]

  return "options" in schema ? schema.options : [true, false]
}

/** One message per key of `object` that `entries` does not know, in the object's order. */
const unknownKeyProblems = (where: string, object: Record<string, unknown>, entries: object, order: readonly number[]): Problem[] =>
  Object.keys(object).flatMap((key, position) =>
    Object.hasOwn(entries, key)
      ? []
      : [{ order: [...order, position], message: `${where} has the unknown key ${key} (known: ${Object.keys(entries).join(", ")})` }],
  )

/** For an object whose every value is a list of strings: the unknown keys whose value is not one, in the object's order. */
const unknownListProblems = (object: Record<string, unknown>, entries: object, order: readonly number[], message: (key: string) => string): Problem[] =>
  Object.entries(object).flatMap(([key, value], position) =>
    Object.hasOwn(entries, key) || v.is(stringList, value) ? [] : [{ order: [...order, position], message: message(key) }],
  )

type PathItem = v.IssuePathItem

/** The value an issue's path passes through at `index`, as an object (an entry of `ownEntries` is a pair). */
const objectAt = (path: readonly PathItem[], index: number): Record<string, unknown> => {
  const value: unknown = path[index]?.value

  return isPlainObject(value) ? value : {}
}

/** The key and value of the `ownEntries` entry at `index` of an issue's path. */
const entryAt = (path: readonly PathItem[], index: number): { readonly name: string; readonly value: Record<string, unknown> } => {
  const pair: unknown = path[index]?.value
  const [name, value]: readonly unknown[] = Array.isArray(pair) ? pair : []

  return { name: String(name), value: isPlainObject(value) ? value : {} }
}

const outlineMessage = (path: readonly PathItem[]): string => {
  const field = path[0]?.key

  if (field === undefined) {
    return "the configuration must be an object"
  }

  if (field === "kinds") {
    return path.length === 1 ? "kinds must map each kind to its rule" : `kind ${entryAt(path, 1).name} must be an object`
  }

  if (field === "packages") {
    return path.length === 1 ? "packages must map package names to their rules" : `package ${entryAt(path, 1).name} must be an object`
  }

  if (field === "imports" || field === "runtimeModules") {
    return `${field} must be an object`
  }

  return `${field === "fileClasses" ? "fileClasses" : "baseline"} must be a list of objects`
}

const kindProblems = (path: readonly PathItem[], unknownKey: boolean, holder: Record<string, unknown>): Problem[] => {
  const index = Number(path[1]?.key)
  const { name } = entryAt(path, 1)

  if (unknownKey) {
    return unknownKeyProblems(`kind ${name}`, holder, kindRuleSchema.entries, [section.kinds, index, 0])
  }

  const field = String(path[3]?.key)
  const messages: Readonly<Record<string, string>> = {
    packages: `kind ${name} names no packages`,
    mayUse: `kind ${name}: mayUse must be "any" or a list of kinds`,
    runtimeModules: `kind ${name}: runtimeModules must be true or false`,
    externals: `kind ${name}: externals must be "any" or a list of package names`,
  }
  const message = messages[field]

  return message === undefined ? [] : [{ order: [section.kinds, index, kindFieldOrder.indexOf(field) + 1], message }]
}

/** The kinds a kind may use that are not kinds: a reference across entries, which no schema of one entry sees. */
const kindReferenceProblems = (kinds: Record<string, unknown>): Problem[] => {
  const known = new Set(Object.keys(kinds))
  const problems: Problem[] = []

  for (const [index, [name, kind]] of Object.entries(kinds).entries()) {
    const mayUse: unknown = isPlainObject(kind) ? kind.mayUse : undefined

    if (!Array.isArray(mayUse)) {
      continue
    }

    // for...of, as in 0.2: a hole of a sparse list is read as undefined, which is not a kind.
    for (const [position, used] of [...(mayUse as unknown[])].entries()) {
      if (typeof used !== "string" || !known.has(used)) {
        problems.push({
          order: [section.kinds, index, kindFieldOrder.length + 1, position],
          message: `kind ${name} may use ${asText(used)}, which is not a kind`,
        })
      }
    }
  }

  return problems
}

const packageProblems = (path: readonly PathItem[], unknownKey: boolean, holder: Record<string, unknown>): Problem[] => {
  const index = Number(path[1]?.key)
  const { name, value } = entryAt(path, 1)
  const listMessage = (key: string) => `package ${name}: ${key} must be a list of strings`

  if (unknownKey) {
    return [
      ...unknownKeyProblems(`package ${name}`, holder, packageRuleSchema.entries, [section.packages, index, 0]),
      ...unknownListProblems(holder, packageRuleSchema.entries, [section.packages, index, 1], listMessage),
    ]
  }

  const field = String(path[3]?.key)

  return [{ order: [section.packages, index, 1, Object.keys(value).indexOf(field)], message: listMessage(field) }]
}

const runtimeModulesProblems = (path: readonly PathItem[], unknownKey: boolean, holder: Record<string, unknown>): Problem[] => {
  const listMessage = (key: string) => `runtimeModules.${key} must be a list of strings`

  if (unknownKey) {
    return [
      ...unknownKeyProblems("runtimeModules", holder, runtimeModulesSchema.entries, [section.runtimeModuleKeys]),
      ...unknownListProblems(holder, runtimeModulesSchema.entries, [section.runtimeModuleValues], listMessage),
    ]
  }

  const field = String(path[1]?.key)

  return [{ order: [section.runtimeModuleValues, Object.keys(objectAt(path, 0)).indexOf(field)], message: listMessage(field) }]
}

const importProblems = (path: readonly PathItem[], unknownKey: boolean, holder: Record<string, unknown>): Problem[] => {
  if (unknownKey) {
    return unknownKeyProblems("imports", holder, importPolicySchema.entries, [section.importKeys])
  }

  const field = String(path[1]?.key)

  if (importFieldOrder.includes(field)) {
    return [{ order: [section.importFields, importFieldOrder.indexOf(field)], message: `imports.${field} must be a list of ${allManifestFields.join(", ")}` }]
  }

  return [
    {
      order: [section.importPolicies, importPolicyOrder.indexOf(field)],
      message: `imports.${field} is ${JSON.stringify(path[1]?.value)}; it must be one of ${policyValues(field).join(", ")}`,
    },
  ]
}

const fileClassProblems = (path: readonly PathItem[], unknownKey: boolean, holder: Record<string, unknown>): Problem[] => {
  const index = Number(path[1]?.key)

  if (unknownKey) {
    return unknownKeyProblems(`file class ${index}`, holder, fileClassSchema.entries, [section.fileClasses, index, 0])
  }

  return path[2]?.key === "files"
    ? [{ order: [section.fileClasses, index, 1], message: `file class ${index}: files must be a list of globs` }]
    : [{ order: [section.fileClasses, index, 2], message: `file class ${index} has the unknown policy ${String(objectAt(path, 1).policy)}` }]
}

const baselineProblems = (path: readonly PathItem[], unknownKey: boolean, holder: Record<string, unknown>): Problem[] => {
  const index = Number(path[1]?.key)
  const entry = objectAt(path, 1)
  const file = asText(entry.file)

  if (unknownKey) {
    return unknownKeyProblems(`the baseline entry for ${file}`, holder, baselineEntrySchema.entries, [section.baseline, index, 0])
  }

  const field = String(path[2]?.key)
  // Built only for the field at fault: 0.2 wrote the rule with a template literal in two of them and with String in one.
  const messages: Readonly<Record<string, () => string>> = {
    rule: () => `the baseline entry for ${file} names the unknown rule ${String(entry.rule)}`,
    target: () => `the baseline entry for ${asText(entry.rule)} in ${file} names no target, so it would hide every future finding of that rule there`,
    reason: () => `the baseline entry for ${asText(entry.rule)} in ${file} has no reason`,
  }
  const message = messages[field]?.()

  return message === undefined ? [] : [{ order: [section.baseline, index, baselineFieldOrder.indexOf(field)], message }]
}

/** The messages for one issue of `configSchema`. */
const problemsOf = (issue: v.BaseIssue<unknown>): Problem[] => {
  const path = issue.path ?? []
  // An unknown key is reported at the key, under the object that holds it; `v.strictObject` reports only the first.
  const unknownKey = issue.type === "strict_object" && issue.expected === "never"
  const at = unknownKey ? path.slice(0, -1) : path
  const holder: unknown = unknownKey ? path.at(-1)?.input : undefined
  const object = isPlainObject(holder) ? holder : {}
  const field = at[0]?.key

  switch (field) {
    case undefined: {
      return unknownKey ? unknownKeyProblems("the configuration", object, configSchema.entries, [section.configurationKeys]) : []
    }

    case "kinds": {
      return kindProblems(path, unknownKey, object)
    }

    case "packages": {
      return packageProblems(path, unknownKey, object)
    }

    case "runtimeModules": {
      return runtimeModulesProblems(path, unknownKey, object)
    }

    case "imports": {
      return importProblems(path, unknownKey, object)
    }

    case "fileClasses": {
      return fileClassProblems(path, unknownKey, object)
    }

    case "baseline": {
      return baselineProblems(path, unknownKey, object)
    }

    case "workspaceScopes": {
      return [{ order: [section.workspaceScopes], message: "workspaceScopes must be a list of scopes" }]
    }

    case "testOnlySpecifiers":
    case "virtualModules":
    case "ignore":
    case "output": {
      return [{ order: [section[field]], message: `${field} must be a list of strings` }]
    }

    default: {
      return []
    }
  }
}

const compareOrders = (left: readonly number[], right: readonly number[]): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1)

    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

/** Problems that make a configuration unusable, as messages: the outline's alone when it does not hold, else every other. */
export const configProblems = (config: Config): string[] => {
  const outline = v.safeParse(outlineSchema, config)

  if (!outline.success) {
    return [...new Set(outline.issues.map((issue) => outlineMessage(issue.path ?? [])))]
  }

  // 0.2's outline skipped the holes of a sparse fileClasses or baseline, and then crashed on them. A hole is reported
  // instead, alone, as 0.2 reported nothing else once it crashed.
  const sparse = (["fileClasses", "baseline"] as const).filter((key) => [...(config[key] ?? [])].includes(undefined as never))

  if (sparse.length > 0) {
    return sparse.map((key) => `${key} must be a list of objects`)
  }

  // 0.2 named every baseline entry's file in a message before checking the entry, so a Symbol there throws here too.
  for (const entry of config.baseline ?? []) {
    asText(entry.file)
  }

  const checked = v.safeParse(configSchema, config)
  const problems = [...(checked.issues ?? []).flatMap(problemsOf), ...kindReferenceProblems(config.kinds)].toSorted((left, right) =>
    compareOrders(left.order, right.order),
  )
  const seen = new Set<string>()

  return problems.flatMap((problem) => {
    const key = problem.order.join(" ")

    if (seen.has(key)) {
      return []
    }

    seen.add(key)

    return [problem.message]
  })
}

export const resolveConfig = (config: Config): ResolvedConfig => {
  const problems = configProblems(config)

  if (problems.length > 0) {
    throw new Error(`ox-dep-lint configuration: ${problems.join("; ")}`)
  }

  const kinds: Record<string, Required<KindRule>> = {}

  for (const [name, kind] of Object.entries(config.kinds)) {
    kinds[name] = { packages: kind.packages, mayUse: kind.mayUse, externals: kind.externals ?? "any", runtimeModules: kind.runtimeModules ?? true }
  }

  return {
    workspaceScopes: config.workspaceScopes,
    kinds,
    packages: config.packages ?? {},
    fileClasses: config.fileClasses ?? defaultFileClasses,
    runtimePrefixes: config.runtimeModules?.prefixes ?? ["node:", "bun:", "cloudflare:"],
    runtimeNames: new Set(config.runtimeModules?.names ?? ["bun", ...builtinModules.filter((name) => !name.startsWith("_"))]),
    virtualPrefixes: config.virtualModules ?? ["virtual:", "astro:"],
    testOnlySpecifiers: config.testOnlySpecifiers ?? [],
    imports: {
      computed: config.imports?.computed ?? "error-in-shipped",
      selfByName: config.imports?.selfByName ?? "allow",
      unresolved: config.imports?.unresolved ?? "error",
      manifestEdgeFields: config.imports?.manifestEdgeFields ?? allManifestFields,
      requireDeclared: config.imports?.requireDeclared ?? true,
      shippedFields: config.imports?.shippedFields ?? ["dependencies", "peerDependencies", "optionalDependencies"],
      typeOnly: config.imports?.typeOnly ?? "relaxed",
    },
    baseline: config.baseline ?? [],
    ignore: config.ignore ?? [],
    output: config.output ?? defaultOutput,
  }
}
