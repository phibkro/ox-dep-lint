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
  /** Outside packages shipped code may import, or `"any"`. Default `"any"`. */
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
  /** Workspace packages it may import only with type-only imports (`import type`, `export type`, `typeof import()`). */
  readonly typeOnlyUses?: readonly string[]
  /** Package-relative globs of files that are checked as development files though they ship (a conformance suite's entry). */
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
  | "forbidden-edge"
  | "type-only-edge"
  | "relative-import-leaves-package"
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
  /** The specifier or package the finding names; absent matches every finding of the rule in the file. */
  readonly target?: string
  readonly reason: string
}

export type ManifestField = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies"

export interface ImportPolicy {
  /** `import(expression)`: an error in shipped code (default), everywhere, or never. */
  readonly computed?: "error-in-shipped" | "error" | "allow"
  /** A package importing itself by its own name. Default `"allow"`. */
  readonly selfByName?: "error" | "allow"
  /** A relative path or alias that names no file. Default `"error"`. */
  readonly unresolved?: "error" | "ignore"
  /** Which `package.json` fields count as edges between workspace packages. Default all four. */
  readonly manifestEdgeFields?: readonly ManifestField[]
  /**
   * Every package a file imports must be declared in its own `package.json`: shipped code in `dependencies`,
   * `peerDependencies` or `optionalDependencies`, development files in any field or the root's devDependencies.
   * Default true. (knip's `unlisted` misses files no entry reaches and root devDependencies used by shipped code.)
   */
  readonly requireDeclared?: boolean
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
  /** Globs over specifiers only development files may import: `fast-check` is that specifier alone, `fast-check/**` its subpaths. */
  readonly testOnlySpecifiers?: readonly string[]
  readonly imports?: ImportPolicy
  readonly baseline?: readonly BaselineEntry[]
  /** Repository-relative globs of files never read (generated code, spikes). */
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
  readonly testOnlySpecifiers: readonly string[]
  readonly imports: Required<ImportPolicy>
  readonly baseline: readonly BaselineEntry[]
  readonly ignore: readonly string[]
}

export const defaultFileClasses: readonly FileClass[] = [
  {
    files: ["test/**", "tests/**", "scripts/**", "**/__tests__/**", "**/fixtures/**", "**/*.test.*", "**/*.spec.*", "**/*.bench.*"],
    policy: "development",
  },
]

const allManifestFields: readonly ManifestField[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]

/** Identity, for type checking a configuration file. */
export const defineConfig = (config: Config): Config => config

/** Problems that make a configuration unusable, as messages. */
export const configProblems = (config: Config): string[] => {
  const problems: string[] = []
  const kinds = new Set(Object.keys(config.kinds))

  for (const [name, kind] of Object.entries(config.kinds)) {
    if (kind.mayUse !== "any") {
      for (const used of kind.mayUse) {
        if (!kinds.has(used)) {
          problems.push(`kind ${name} may use ${used}, which is not a kind`)
        }
      }
    }

    if (kind.packages.length === 0) {
      problems.push(`kind ${name} names no packages`)
    }
  }

  for (const entry of config.baseline ?? []) {
    if (entry.reason.trim() === "") {
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
    testOnlySpecifiers: config.testOnlySpecifiers ?? [],
    imports: {
      computed: config.imports?.computed ?? "error-in-shipped",
      selfByName: config.imports?.selfByName ?? "allow",
      unresolved: config.imports?.unresolved ?? "error",
      manifestEdgeFields: config.imports?.manifestEdgeFields ?? allManifestFields,
      requireDeclared: config.imports?.requireDeclared ?? true,
    },
    baseline: config.baseline ?? [],
    ignore: config.ignore ?? [],
  }
}
