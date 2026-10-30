/**
 * The oxlint JS plugin: rule `dep-lint/imports` reports the per-file findings of the engine where they are written.
 * Configure it with the same configuration the CLI reads, as the rule's option:
 *
 *   jsPlugins: ["ox-dep-lint/plugin"],
 *   rules: { "dep-lint/imports": ["error", depLintConfig] }
 *
 * Whole-graph checks (package.json edges and externals, package cycles, stale baseline entries) need the CLI.
 */
import { statSync } from "node:fs"
import nodePath from "node:path"
import type { Config } from "./config.ts"
import { createEngine, findingsForFile, withoutBaselined } from "./engine.ts"
import type { Engine } from "./engine.ts"
import { attempt, failure } from "./result.ts"
import type { Result } from "./result.ts"
import { findWorkspaceRoot } from "./workspace.ts"

interface RuleContext {
  readonly filename: string
  readonly options: readonly unknown[]
  readonly settings: Readonly<Record<string, unknown>>
  readonly sourceCode: { readonly text: string }
  readonly report: (
    diagnostic:
      | { readonly message: string; readonly loc: { readonly start: { readonly line: number; readonly column: number } } }
      | { readonly message: string; readonly node: { readonly range: readonly [number, number] } },
  ) => void
}

interface Cached {
  readonly engine: Result<Engine, Error>
  /** The package.json files the engine read, with their modification times. */
  readonly manifests: ReadonlyMap<string, number>
  checkedAt: number
}

/** How often (milliseconds) a long-lived process (an editor's language server) looks for changed package.json files. */
const recheckInterval = 1000

const cache = new Map<string, Cached>()
const roots = new Map<string, string | undefined>()

const modified = (path: string): number => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

const manifestsOf = (root: string, engine: Result<Engine, Error>): Map<string, number> => {
  const directories = engine.ok ? engine.value.workspace.packages.map((entry) => nodePath.join(root, entry.directory)) : []
  // The directories that hold packages too: adding a package there changes their modification time.
  const paths = [
    nodePath.join(root, "package.json"),
    ...directories.map((directory) => nodePath.join(directory, "package.json")),
    ...new Set(directories.map((directory) => nodePath.dirname(directory))),
  ]

  return new Map(paths.map((path) => [path, modified(path)]))
}

const build = (root: string, config: Config): Result<Engine, Error> => {
  const built = attempt(() => createEngine(root, config))

  return built.ok ? built : failure(built.error instanceof Error ? built.error : new Error(String(built.error)))
}

/** The engine for `root` and `config`, rebuilt when a package.json it read has changed. */
const engineFor = (root: string, config: Config): Result<Engine, Error> => {
  const key = `${root}\0${JSON.stringify(config)}`
  const now = Date.now()
  const cached = cache.get(key)

  if (cached !== undefined) {
    if (now - cached.checkedAt < recheckInterval) {
      return cached.engine
    }

    cached.checkedAt = now

    if ([...cached.manifests].every(([path, time]) => modified(path) === time)) {
      return cached.engine
    }
  }

  const engine = build(root, config)
  cache.set(key, { engine, manifests: manifestsOf(root, engine), checkedAt: now })

  return engine
}

const rootFor = (directory: string): string | undefined => {
  if (!roots.has(directory)) {
    roots.set(directory, findWorkspaceRoot(directory))
  }

  return roots.get(directory)
}

const start = { line: 1, column: 0 }

const imports = {
  meta: {
    type: "problem",
    docs: { description: "Package kinds, outside packages, runtime and test-only modules, undeclared, escaping and computed imports." },
    schema: false,
  },
  create(context: RuleContext) {
    return {
      Program() {
        // SAFETY: createEngine validates the configuration and the failure is reported below.
        const config = (context.options[0] ?? context.settings["ox-dep-lint"]) as Config | undefined

        if (config === undefined) {
          context.report({ message: "dep-lint/imports needs the ox-dep-lint configuration as its option", loc: { start } })

          return
        }

        const root = rootFor(nodePath.dirname(context.filename))

        if (root === undefined) {
          context.report({ message: "no package.json with workspaces at or above this file, so ox-dep-lint cannot place it", loc: { start } })

          return
        }

        const built = engineFor(root, config)

        if (!built.ok) {
          context.report({ message: built.error.message, loc: { start } })

          return
        }

        const engine = built.value

        const file = nodePath.relative(root, context.filename).split(nodePath.sep).join("/")

        for (const finding of withoutBaselined(engine, findingsForFile(engine, file, context.sourceCode.text))) {
          const message = `${finding.rule}: ${finding.message}`
          // By offsets where the finding has them, which oxlint maps to places itself (a byte order mark included).
          context.report(
            finding.start === undefined || finding.end === undefined
              ? { message, loc: { start: { line: finding.line, column: finding.column } } }
              : { message, node: { range: [finding.start, finding.end] } },
          )
        }
      },
    }
  },
}

const plugin = { meta: { name: "dep-lint" }, rules: { imports } }

export default plugin
