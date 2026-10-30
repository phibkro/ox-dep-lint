/**
 * The oxlint JS plugin: rule `dep-lint/imports` reports the per-file findings of the engine where they are written.
 * Configure it with the same configuration the CLI reads, as the rule's option:
 *
 *   jsPlugins: ["ox-dep-lint/plugin"],
 *   rules: { "dep-lint/imports": ["error", depLintConfig] }
 *
 * Whole-graph checks (package.json edges, package cycles, stale baseline entries) need the CLI.
 */
import nodePath from "node:path"
import type { Config } from "./config.ts"
import { createEngine, findingsForFile, withoutBaselined } from "./engine.ts"
import type { Engine } from "./engine.ts"
import { findWorkspaceRoot } from "./workspace.ts"

interface RuleContext {
  readonly filename: string
  readonly options: readonly unknown[]
  readonly settings: Readonly<Record<string, unknown>>
  readonly sourceCode: { readonly text: string }
  readonly report: (diagnostic: { readonly message: string; readonly loc: { readonly start: { readonly line: number; readonly column: number } } }) => void
}

const engines = new Map<string, Engine>()
const roots = new Map<string, string | undefined>()

const configOf = (context: RuleContext): Config | undefined => {
  const [option] = context.options
  const setting = context.settings["ox-dep-lint"]

  // SAFETY: createEngine validates the configuration and throws with its problems.
  return (option ?? setting) as Config | undefined
}

const engineFor = (root: string, config: Config): Engine => {
  const key = `${root}\0${JSON.stringify(config)}`
  let engine = engines.get(key)

  if (engine === undefined) {
    engine = createEngine(root, config)
    engines.set(key, engine)
  }

  return engine
}

const rootFor = (directory: string): string | undefined => {
  if (!roots.has(directory)) {
    roots.set(directory, findWorkspaceRoot(directory))
  }

  return roots.get(directory)
}

const imports = {
  meta: {
    type: "problem",
    docs: { description: "Package kinds, outside packages, runtime and test-only modules, undeclared, escaping and computed imports." },
    schema: false,
  },
  create(context: RuleContext) {
    return {
      Program() {
        const config = configOf(context)
        const root = rootFor(nodePath.dirname(context.filename))

        if (config === undefined || root === undefined) {
          return
        }

        const engine = engineFor(root, config)
        const file = nodePath.relative(root, context.filename).split(nodePath.sep).join("/")

        for (const finding of withoutBaselined(engine, findingsForFile(engine, file, context.sourceCode.text))) {
          context.report({ message: `${finding.rule}: ${finding.message}`, loc: { start: { line: finding.line, column: finding.column } } })
        }
      },
    }
  },
}

const plugin = { meta: { name: "dep-lint" }, rules: { imports } }

export default plugin
