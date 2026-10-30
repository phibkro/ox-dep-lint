/**
 * Checks that need the whole workspace rather than one file: edges declared only in `package.json`, cycles between
 * packages, packages no kind holds, and baseline entries no finding needs any more. Only the CLI runs these, because an
 * oxlint plugin sees one file at a time and never sees `package.json`.
 */
import type { ManifestField } from "./config.ts"
import { baselineCovers, edgeRefusal } from "./engine.ts"
import type { Engine, Finding } from "./engine.ts"

const runtimeFields: readonly ManifestField[] = ["dependencies", "optionalDependencies", "peerDependencies"]

export const graphFindings = (engine: Engine): Finding[] => {
  const { config, workspace } = engine
  const findings: Finding[] = []
  const at = { line: 1, column: 0 }

  for (const entry of workspace.packages) {
    const manifest = `${entry.directory}/package.json`

    if (engine.kindOf(entry) === undefined) {
      findings.push({
        rule: "package-without-kind",
        file: manifest,
        ...at,
        message: `${entry.name} matches no kind: add its directory to one`,
        target: entry.name,
      })
      continue
    }

    for (const field of config.imports.manifestEdgeFields) {
      for (const name of entry.manifest[field]) {
        const to = workspace.byName.get(name)

        if (to === undefined) {
          if (config.workspaceScopes.some((scope) => name.startsWith(scope))) {
            findings.push({
              rule: "unknown-workspace-package",
              file: manifest,
              ...at,
              message: `${field} names ${name}, which is not a workspace package`,
              target: name,
            })
          }

          continue
        }

        // A declaration alone is not type-only, so a typeOnlyUses package may be declared (it is needed to resolve types).
        const refusal = edgeRefusal(engine, entry, to, true)

        if (refusal !== undefined && to.name !== entry.name) {
          findings.push({ rule: refusal.rule, file: manifest, ...at, message: `${field}: ${refusal.why}`, target: name })
        }
      }
    }
  }

  findings.push(...packageCycles(engine))

  return findings
}

/** Cycles between workspace packages through their runtime dependency fields, each reported once. */
const packageCycles = (engine: Engine): Finding[] => {
  const { workspace } = engine
  const edges = new Map(
    workspace.packages.map((entry) => [
      entry.name,
      [...new Set(runtimeFields.flatMap((field) => entry.manifest[field]))].filter((name) => workspace.byName.has(name) && name !== entry.name),
    ]),
  )
  const state = new Map<string, "visiting" | "done">()
  const findings: Finding[] = []
  const seen = new Set<string>()

  const visit = (name: string, path: readonly string[]) => {
    if (state.get(name) === "done") {
      return
    }

    if (state.get(name) === "visiting") {
      const cycle = [...path.slice(path.indexOf(name)), name]
      const key = cycle.slice(0, -1).toSorted().join(" ")

      if (!seen.has(key)) {
        seen.add(key)
        const first = workspace.byName.get(name)
        findings.push({
          rule: "package-cycle",
          file: `${first?.directory ?? name}/package.json`,
          line: 1,
          column: 0,
          message: `dependency cycle: ${cycle.join(" -> ")}`,
          target: key,
        })
      }

      return
    }

    state.set(name, "visiting")

    for (const next of edges.get(name) ?? []) {
      visit(next, [...path, name])
    }

    state.set(name, "done")
  }

  for (const name of [...edges.keys()].toSorted()) {
    visit(name, [])
  }

  return findings
}

/** Baseline entries that no finding in `findings` needs; each is a finding of its own, so the baseline only shrinks. */
export const staleBaseline = (engine: Engine, findings: readonly Finding[]): Finding[] =>
  engine.config.baseline
    .filter((entry) => !findings.some((finding) => baselineCovers(entry, finding)))
    .map((entry) => ({
      rule: "stale-baseline",
      file: entry.file,
      line: 1,
      column: 0,
      message: `the baseline entry for ${entry.rule}${entry.target === undefined ? "" : ` (${entry.target})`} is no longer needed: remove it`,
      target: entry.rule,
    }))
