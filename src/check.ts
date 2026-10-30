/** The whole check: every source file of the workspace through the engine, plus the whole-graph checks and the baseline. */
import { readdirSync, readFileSync, statSync } from "node:fs"
import nodePath from "node:path"
import type { Config } from "./config.ts"
import { createEngine, findingsForFile, reads, withoutBaselined } from "./engine.ts"
import type { Engine, Finding } from "./engine.ts"
import { graphFindings, staleBaseline } from "./graph.ts"

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Every source file the engine reads, found by walking each package's directory (skipping `node_modules` and dot
 * directories). A walk rather than `git ls-files`: generated and gitignored sources still ship, and a nested repository
 * or submodule inside a package is still part of it.
 */
export const listSourceFiles = (engine: Engine): string[] => {
  const files = new Set<string>()

  const walk = (relative: string) => {
    for (const entry of readdirSync(nodePath.join(engine.workspace.root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`

      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        walk(path)
      } else if ((entry.isFile() || (entry.isSymbolicLink() && isFile(nodePath.join(engine.workspace.root, path)))) && reads(engine, path)) {
        files.add(path)
      }
    }
  }

  for (const entry of engine.workspace.packages) {
    walk(entry.directory)
  }

  return [...files].toSorted()
}

export interface CheckResult {
  readonly files: number
  readonly findings: readonly Finding[]
}

export const checkWorkspace = (root: string, config: Config): CheckResult => {
  const engine = createEngine(root, config)
  const files = listSourceFiles(engine)
  // A package with no kind is reported once, from its package.json, by the graph checks.
  const perFile = files
    .flatMap((file) => findingsForFile(engine, file, readFileSync(nodePath.join(root, file), "utf8")))
    .filter((finding) => finding.rule !== "package-without-kind")
  const all = [...perFile, ...graphFindings(engine)]

  return { files: files.length, findings: [...withoutBaselined(engine, all), ...staleBaseline(engine, all)] }
}

export const formatFinding = (finding: Finding): string => `${finding.file}:${finding.line}:${finding.column + 1} ${finding.rule}: ${finding.message}`
