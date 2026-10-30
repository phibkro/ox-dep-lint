/** The whole check: every source file of the workspace through the engine, plus the whole-graph checks and the baseline. */
import { readdirSync, readFileSync } from "node:fs"
import type { Dirent } from "node:fs"
import nodePath from "node:path"
import type { Config } from "./config.ts"
import {
  createEngine,
  findingsForFile,
  linkDestination,
  passedOver,
  reads,
  reportsLink,
  skipsDirectory,
  symbolicLinkFinding,
  unreadablePathFinding,
  withoutBaselined,
} from "./engine.ts"
import type { Engine, Finding } from "./engine.ts"
import { graphFindings, staleBaseline } from "./graph.ts"
import { attempt, codeOf, vanished } from "./result.ts"

/** The source files of the workspace's packages, and what kept the walk from seeing all of them. */
export interface SourceWalk {
  readonly files: readonly string[]
  /** A `symbolic-link` finding for each link outside the directories it skips, an `unreadable-path` one for each directory it could not list. */
  readonly findings: readonly Finding[]
}

/**
 * Every source file the engine reads, found by walking each package's directory (skipping `node_modules` and `.git`;
 * other dot directories hold sources too). A walk rather than `git ls-files`: generated and gitignored sources still
 * ship, and a nested repository or submodule inside a package is still part of it. A symbolic link is never followed:
 * every one is a finding, whatever it points at, unless it lies in a directory the check skips on purpose; and so is a
 * directory the walk cannot list. A path removed between being listed and being read is skipped, with no finding.
 */
export const walkSources = (engine: Engine): SourceWalk => {
  const files = new Set<string>()
  const findings = new Map<string, Finding>()
  const { root } = engine.workspace

  const walk = (relative: string) => {
    let entries: Dirent[]

    try {
      entries = readdirSync(nodePath.join(root, relative), { withFileTypes: true })
    } catch (cause) {
      // Removed (or replaced by a file) since its parent was listed: nothing is there to check.
      if (!vanished(cause) && !skipsDirectory(engine, relative)) {
        findings.set(relative, unreadablePathFinding(relative, codeOf(cause)))
      }

      return
    }

    for (const entry of entries) {
      const path = `${relative}/${entry.name}`

      if (entry.isDirectory()) {
        if (!passedOver(entry.name)) {
          walk(path)
        }
      } else if (entry.isSymbolicLink()) {
        const destination = reportsLink(engine, path) ? linkDestination(nodePath.join(root, path)) : undefined

        if (destination !== undefined) {
          findings.set(path, symbolicLinkFinding(path, destination))
        }
      } else if (entry.isFile() && reads(engine, path)) {
        files.add(path)
      }
    }
  }

  for (const entry of engine.workspace.packages) {
    walk(entry.directory)
  }

  return { files: [...files].toSorted(), findings: [...findings.values()].toSorted((left, right) => left.file.localeCompare(right.file)) }
}

/** The source files `walkSources` finds. */
export const listSourceFiles = (engine: Engine): string[] => [...walkSources(engine).files]

export interface CheckResult {
  readonly files: number
  readonly findings: readonly Finding[]
}

export const checkWorkspace = (root: string, config: Config): CheckResult => {
  const engine = createEngine(root, config)
  const { files, findings: walked } = walkSources(engine)
  const perFile: Finding[] = []
  let checked = 0

  for (const file of files) {
    const text = attempt(() => readFileSync(nodePath.join(root, file), "utf8"))

    if (text.ok) {
      checked += 1
      perFile.push(...findingsForFile(engine, file, text.value))
    } else if (!vanished(text.error)) {
      // A file removed since the walk listed it is no file to check; one that cannot be read for another reason is a finding.
      checked += 1
      perFile.push(unreadablePathFinding(file, codeOf(text.error), "file"))
    }
  }

  // A package with no kind is reported once, from its package.json, by the graph checks.
  const all = [...walked, ...perFile.filter((finding) => finding.rule !== "package-without-kind"), ...graphFindings(engine)]

  return { files: checked, findings: [...withoutBaselined(engine, all), ...staleBaseline(engine, all)] }
}

export const formatFinding = (finding: Finding): string => `${finding.file}:${finding.line}:${finding.column + 1} ${finding.rule}: ${finding.message}`
