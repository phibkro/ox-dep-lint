/** The whole check: every source file of the workspace through the engine, plus the whole-graph checks and the baseline. */
import { readdirSync, readFileSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import nodePath from "node:path"
import type { Config } from "./config.ts"
import {
  createEngine,
  effectivePolicy,
  findingsForFile,
  linkDestination,
  reads,
  skipsDirectory,
  symbolicLinkFinding,
  unreadableDirectoryFinding,
  withoutBaselined,
} from "./engine.ts"
import type { Engine, Finding } from "./engine.ts"
import { graphFindings, staleBaseline } from "./graph.ts"
import { codeOf } from "./result.ts"
import { packageOfFile } from "./workspace.ts"

/** What a symbolic link names: a file (anything that is not a directory), a directory, or nothing it can reach (dangling, a cycle). */
const destinationKind = (absolute: string): "file" | "directory" | "unreachable" => {
  try {
    return statSync(absolute).isDirectory() ? "directory" : "file"
  } catch {
    return "unreachable"
  }
}

/** The source files of the workspace's packages, and what kept the walk from seeing all of them. */
export interface SourceWalk {
  readonly files: readonly string[]
  /** A `symbolic-link` finding for each link where the check would read, an `unreadable-directory` one for each directory it could not list. */
  readonly findings: readonly Finding[]
}

/**
 * Every source file the engine reads, found by walking each package's directory (skipping `node_modules` and dot
 * directories). A walk rather than `git ls-files`: generated and gitignored sources still ship, and a nested repository
 * or submodule inside a package is still part of it. A symbolic link is never followed: one where the check would read
 * (a file link it would read, or a directory, dangling or cyclic link under a directory it does not skip) is a finding,
 * and so is a directory it cannot list.
 */
export const walkSources = (engine: Engine): SourceWalk => {
  const files = new Set<string>()
  const findings = new Map<string, Finding>()
  const { root } = engine.workspace
  const hidden = (name: string) => name === "node_modules" || name.startsWith(".")

  const symbolicLink = (path: string, name: string) => {
    const absolute = nodePath.join(root, path)
    const owner = packageOfFile(engine.workspace, path)
    const kind = destinationKind(absolute)
    const read =
      kind === "file"
        ? owner !== undefined && reads(engine, path) && effectivePolicy(engine, owner, path.slice(owner.directory.length + 1)) !== "unchecked"
        : !hidden(name) && !skipsDirectory(engine, path)

    if (read) {
      findings.set(path, symbolicLinkFinding(path, linkDestination(absolute)))
    }
  }

  const walk = (relative: string) => {
    let entries: Dirent[]

    try {
      entries = readdirSync(nodePath.join(root, relative), { withFileTypes: true })
    } catch (cause) {
      if (!skipsDirectory(engine, relative)) {
        findings.set(relative, unreadableDirectoryFinding(relative, codeOf(cause)))
      }

      return
    }

    for (const entry of entries) {
      const path = `${relative}/${entry.name}`

      if (entry.isDirectory()) {
        if (!hidden(entry.name)) {
          walk(path)
        }
      } else if (entry.isSymbolicLink()) {
        symbolicLink(path, entry.name)
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
  // A package with no kind is reported once, from its package.json, by the graph checks.
  const perFile = files
    .flatMap((file) => findingsForFile(engine, file, readFileSync(nodePath.join(root, file), "utf8")))
    .filter((finding) => finding.rule !== "package-without-kind")
  const all = [...walked, ...perFile, ...graphFindings(engine)]

  return { files: files.length, findings: [...withoutBaselined(engine, all), ...staleBaseline(engine, all)] }
}

export const formatFinding = (finding: Finding): string => `${finding.file}:${finding.line}:${finding.column + 1} ${finding.rule}: ${finding.message}`
