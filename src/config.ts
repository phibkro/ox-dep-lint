import { builtinModules } from "node:module"

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

export type RuleName =
  | "unknown-workspace-package"
  | "package-without-kind"
  | "package-outside-workspace"
  | "invalid-package"
  | "forbidden-edge"
  | "type-only-edge"
  | "relative-import-leaves-package"
  | "package-path-escape"
  | "shipped-imports-development-file"
  | "self-import-by-name"
  | "forbidden-external"
  | "runtime-module"
  | "test-only-in-shipped"
  | "undeclared-import"
  | "computed-import"
  | "unresolved-import"
  | "package-cycle"
  | "stale-baseline"
  | "parse-error"

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
  /** Repository-relative globs of files never read. Every package's `dist/**` and `coverage/**` are never read either. */
  readonly ignore?: readonly string[]
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
}

export const defaultFileClasses: readonly FileClass[] = [
  {
    files: ["test/**", "tests/**", "scripts/**", "*.config.*", "**/__tests__/**", "**/fixtures/**", "**/*.test.*", "**/*.spec.*", "**/*.bench.*"],
    policy: "development",
  },
]

/** Build output and coverage reports under a package, never read. */
export const packageOutput: readonly string[] = ["dist/**", "coverage/**"]

const allManifestFields: readonly ManifestField[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]

/** Identity, for type checking a configuration file. */
export const defineConfig = (config: Config): Config => config

const allowedKeys = {
  config: ["workspaceScopes", "kinds", "packages", "fileClasses", "runtimeModules", "virtualModules", "testOnlySpecifiers", "imports", "baseline", "ignore"],
  kind: ["packages", "mayUse", "externals", "runtimeModules"],
  package: ["uses", "externals", "typeOnlyUses", "valueSpecifiers", "testSupportFiles"],
  fileClass: ["files", "policy"],
  runtimeModules: ["prefixes", "names"],
  imports: ["computed", "selfByName", "unresolved", "manifestEdgeFields", "requireDeclared", "shippedFields"],
  baseline: ["file", "rule", "target", "reason"],
}

const choices: Record<string, readonly unknown[]> = {
  computed: ["error-in-shipped", "error", "allow"],
  selfByName: ["error", "allow"],
  unresolved: ["error", "ignore"],
  requireDeclared: [true, false],
}

const unknownKeys = (where: string, value: unknown, allowed: readonly string[]): string[] =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value)
        .filter((key) => !allowed.includes(key))
        .map((key) => `${where} has the unknown key ${key} (known: ${allowed.join(", ")})`)
    : [`${where} is not an object`]

/** Problems that make a configuration unusable, as messages. A misspelled key is a problem, never a silent default. */
export const configProblems = (config: Config): string[] => {
  const problems = unknownKeys("the configuration", config, allowedKeys.config)

  if (!Array.isArray(config.workspaceScopes)) {
    problems.push("workspaceScopes must be a list of scopes")
  }

  if (typeof config.kinds !== "object" || config.kinds === null) {
    problems.push("kinds must map each kind to its rule")

    return problems
  }

  const kinds = new Set(Object.keys(config.kinds))

  for (const [name, kind] of Object.entries(config.kinds)) {
    problems.push(...unknownKeys(`kind ${name}`, kind, allowedKeys.kind))

    if (!Array.isArray(kind.packages) || kind.packages.length === 0) {
      problems.push(`kind ${name} names no packages`)
    }

    if (kind.mayUse !== "any") {
      for (const used of Array.isArray(kind.mayUse) ? kind.mayUse : []) {
        if (!kinds.has(used)) {
          problems.push(`kind ${name} may use ${used}, which is not a kind`)
        }
      }
    }
  }

  for (const [name, refinements] of Object.entries(config.packages ?? {})) {
    problems.push(...unknownKeys(`package ${name}`, refinements, allowedKeys.package))
  }

  for (const [index, fileClass] of (config.fileClasses ?? []).entries()) {
    problems.push(...unknownKeys(`file class ${index}`, fileClass, allowedKeys.fileClass))

    if (!["shipped", "development", "unchecked"].includes(fileClass.policy)) {
      problems.push(`file class ${index} has the unknown policy ${String(fileClass.policy)}`)
    }
  }

  if (config.runtimeModules !== undefined) {
    problems.push(...unknownKeys("runtimeModules", config.runtimeModules, allowedKeys.runtimeModules))
  }

  if (config.imports !== undefined) {
    problems.push(...unknownKeys("imports", config.imports, allowedKeys.imports))

    for (const [key, allowed] of Object.entries(choices)) {
      const value: unknown = (config.imports as Record<string, unknown>)[key]

      if (value !== undefined && !allowed.includes(value)) {
        problems.push(`imports.${key} is ${JSON.stringify(value)}; it must be one of ${allowed.join(", ")}`)
      }
    }
  }

  for (const entry of config.baseline ?? []) {
    problems.push(...unknownKeys(`the baseline entry for ${entry.file}`, entry, allowedKeys.baseline))

    if (typeof entry.target !== "string" || entry.target === "") {
      problems.push(`the baseline entry for ${entry.rule} in ${entry.file} names no target, so it would hide every future finding of that rule there`)
    }

    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`the baseline entry for ${entry.rule} in ${entry.file} has no reason`)
    }
  }

  return problems
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
    },
    baseline: config.baseline ?? [],
    ignore: config.ignore ?? [],
  }
}
