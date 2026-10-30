/** The whole check: every source file of the workspace through the engine, plus the whole-graph checks and the baseline. */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import nodePath from "node:path"
import type { Config } from "./config.ts"
import { createEngine, findingsForFile, withoutBaselined } from "./engine.ts"
import type { Finding } from "./engine.ts"
import { graphFindings, staleBaseline } from "./graph.ts"

const sourceFile = /\.[cm]?[jt]sx?$/u

/** Every source file under `root`: what git tracks or would track (so ignored and generated files are left out), else a walk. */
export const listSourceFiles = (root: string): string[] => {
  let listed: string[]

  try {
    listed = execFileSync("git", ["ls-files", "-c", "-o", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter((path) => path !== "")
  } catch {
    listed = []
    const walk = (relative: string) => {
      for (const entry of readdirSync(nodePath.join(root, relative), { withFileTypes: true })) {
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`

        if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          walk(path)
        } else if (entry.isFile()) {
          listed.push(path)
        }
      }
    }

    walk("")
  }

  return listed.filter((path) => sourceFile.test(path) && existsSync(nodePath.join(root, path))).toSorted()
}

export interface CheckResult {
  readonly files: number
  readonly findings: readonly Finding[]
}

export const checkWorkspace = (root: string, config: Config): CheckResult => {
  const engine = createEngine(root, config)
  const files = listSourceFiles(root)
  // A package with no kind is reported once, from its package.json, by the graph checks.
  const perFile = files
    .flatMap((file) => findingsForFile(engine, file, readFileSync(nodePath.join(root, file), "utf8")))
    .filter((finding) => finding.rule !== "package-without-kind")
  const all = [...perFile, ...graphFindings(engine)]

  return { files: files.length, findings: [...withoutBaselined(engine, all), ...staleBaseline(engine, all)] }
}

export const formatFinding = (finding: Finding): string => `${finding.file}:${finding.line}:${finding.column + 1} ${finding.rule}: ${finding.message}`
