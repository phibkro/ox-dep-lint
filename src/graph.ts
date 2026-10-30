/**
 * Checks that need the whole workspace rather than one file: edges declared only in `package.json`, cycles between
 * packages, packages no kind holds, directories the workspaces match that no package owns, and baseline entries no
 * finding needs any more. Only the CLI runs these, because an oxlint plugin sees one file at a time and never sees
 * `package.json`.
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import nodePath from "node:path"
import type { ManifestField } from "./config.ts"
import {
  baselineCovers,
  coversDirectory,
  edgeRefusal,
  ignoresDirectory,
  linkDestination,
  passedOver,
  symbolicLinkFinding,
  unreadablePathFinding,
} from "./engine.ts"
import type { Engine, Finding } from "./engine.ts"
import { matchesGlob } from "./glob.ts"
import { codeOf } from "./result.ts"
import { directoriesMatching } from "./workspace.ts"
import type { Unlisted } from "./workspace.ts"

const runtimeFields: readonly ManifestField[] = ["dependencies", "optionalDependencies", "peerDependencies"]

export const graphFindings = (engine: Engine): Finding[] => {
  const { config, workspace } = engine
  const findings: Finding[] = []
  const at = { line: 1, column: 0 }

  for (const problem of workspace.problems) {
    findings.push({ rule: "invalid-package", file: `${problem.directory}/package.json`, ...at, message: problem.message, target: problem.directory })
  }

  // A directory a kind names, with a package.json, that the workspace leaves out would otherwise go unchecked.
  const members = new Set([...workspace.packages.map((entry) => entry.directory), ...workspace.problems.map((problem) => problem.directory)])
  // What a kind's globs could not list or follow is reported with what the workspaces globs could not.
  const unlistedByKinds: Unlisted = { links: [], unreadable: [], dotDirectories: [] }

  for (const kind of Object.values(config.kinds)) {
    for (const pattern of kind.packages) {
      for (const directory of directoriesMatching(workspace.root, pattern, unlistedByKinds)) {
        if (!members.has(directory) && existsSync(nodePath.join(workspace.root, directory, "package.json"))) {
          members.add(directory)
          findings.push({
            rule: "package-outside-workspace",
            file: `${directory}/package.json`,
            ...at,
            message: `${directory} is a package a kind names, but the root package.json's workspaces leave it out, so nothing in it is checked`,
            target: directory,
          })
        }
      }
    }
  }

  findings.push(...directoriesWithoutPackage(engine, members, unlistedByKinds))

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

    const kindRule = config.kinds[engine.kindOf(entry) ?? ""]
    const extra = config.packages[entry.name]?.externals ?? []

    for (const field of config.imports.shippedFields) {
      for (const name of entry.manifest[field]) {
        const outside = !workspace.byName.has(name) && !config.workspaceScopes.some((scope) => name.startsWith(scope))
        // An npm: alias is judged by the package it installs.
        const installed = entry.aliases.get(name) ?? name

        if (outside && kindRule !== undefined && kindRule.externals !== "any" && !kindRule.externals.includes(installed) && !extra.includes(installed)) {
          findings.push({
            rule: "forbidden-external",
            file: manifest,
            ...at,
            message: `${field} names ${installed === name ? name : `${name} (${installed})`}, which its kind does not allow`,
            target: installed,
          })
        }
      }
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

const isDirectory = (absolute: string): boolean => {
  try {
    return statSync(absolute).isDirectory()
  } catch {
    return false
  }
}

/** Whether `absolute`, links followed, is something other than a directory; false when nothing is there. */
const isFile = (absolute: string): boolean => {
  try {
    return !statSync(absolute).isDirectory()
  } catch {
    return false
  }
}

/** The error code of a directory that cannot be listed, or undefined when it can. */
const unreadable = (absolute: string): string | undefined => {
  try {
    readdirSync(absolute)

    return undefined
  } catch (cause) {
    return codeOf(cause)
  }
}

/**
 * What the root's `workspaces` globs (and a kind's globs) match that is no package: a directory without a
 * `package.json`, whose files no package owns and so nothing checks (only the topmost of nested ones); a dot directory,
 * which no workspaces glob matches; a directory the globs cannot list; and a symbolic link to a directory (or to
 * nothing), which is never followed. Inside a member the walk reports these, so they are left to it. A directory above a member (under `packages/**`), one a negated glob or `ignore` leaves out, and
 * anything under `node_modules` or `.git` are not reported.
 */
const directoriesWithoutPackage = (engine: Engine, members: ReadonlySet<string>, unlistedByKinds: Unlisted): Finding[] => {
  const { workspace } = engine
  const negated = workspace.globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1).replace(/^\.\//u, "").replace(/\/$/u, ""))
  const inside = (path: string) => [...members].some((member) => path === member || path.startsWith(`${member}/`))
  const above = (path: string) => [...members].some((member) => member.startsWith(`${path}/`))
  const leftOut = (path: string) =>
    path.split("/").some(passedOver) ||
    negated.some((pattern) => matchesGlob(path, pattern) || coversDirectory(pattern, path)) ||
    ignoresDirectory(engine, path)
  const candidates = new Map<string, string>()
  const unlisted: Unlisted = { links: [...unlistedByKinds.links], unreadable: [...unlistedByKinds.unreadable], dotDirectories: [] }

  for (const glob of workspace.globs.filter((pattern) => !pattern.startsWith("!"))) {
    for (const directory of directoriesMatching(workspace.root, glob, unlisted)) {
      if (!candidates.has(directory)) {
        candidates.set(directory, glob)
      }
    }
  }

  const withoutPackage = (directory: string, glob: string): Finding | undefined => {
    if (above(directory) || !isDirectory(nodePath.join(workspace.root, directory))) {
      return undefined
    }

    const code = unreadable(nodePath.join(workspace.root, directory))

    return code === undefined
      ? {
          rule: "directory-without-package",
          file: directory,
          line: 1,
          column: 0,
          message: `${directory} matches the workspaces glob ${glob} but has no package.json, so no package owns what it holds and nothing in it is checked: make it a package, remove it, or add ${directory}/** to ignore`,
          target: directory,
        }
      : unreadablePathFinding(directory, code)
  }

  const dotDirectory = (directory: string): Finding => ({
    rule: "directory-without-package",
    file: directory,
    line: 1,
    column: 0,
    message: `${directory} is a dot directory, which workspaces globs never match, so it is no package${existsSync(nodePath.join(workspace.root, directory, "package.json")) ? " though it has a package.json" : ""} and nothing in it is checked: rename it, list it in workspaces by its full path, remove it, or add ${directory}/** to ignore`,
    target: directory,
  })

  // Every candidate, shortest path first, so the topmost of nested ones is reported and what lies below it is not.
  const pending: { readonly path: string; readonly finding: () => Finding | undefined }[] = [
    ...unlisted.unreadable.map(({ directory, code }) => ({ path: directory, finding: () => unreadablePathFinding(directory, code) })),
    ...[...candidates].map(([directory, glob]) => ({ path: directory, finding: () => withoutPackage(directory, glob) })),
    ...unlisted.dotDirectories.map((directory) => ({ path: directory, finding: () => dotDirectory(directory) })),
    // A link to a file is no package, as a file there is none; a link to a directory, or to nothing, may be one.
    ...unlisted.links.map((link) => ({
      path: link,
      finding: () =>
        isFile(nodePath.join(workspace.root, link)) ? undefined : symbolicLinkFinding(link, linkDestination(nodePath.join(workspace.root, link))),
    })),
  ].toSorted((left, right) => left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path))

  const findings = new Map<string, Finding>()

  for (const { path, finding } of pending) {
    const reportedAbove = [...findings.keys()].some((reported) => path.startsWith(`${reported}/`))

    if (findings.has(path) || inside(path) || leftOut(path) || reportedAbove) {
      continue
    }

    const made = finding()

    if (made !== undefined) {
      findings.set(path, made)
    }
  }

  return [...findings.values()].toSorted((left, right) => left.file.localeCompare(right.file))
}

/** A directed graph's strongly connected components, and the cycle routes the search behind them closes. */
export interface Components {
  /** Every component, in the order Tarjan's algorithm completes them (a component before any that reaches it). */
  readonly components: readonly (readonly string[])[]
  /**
   * The cycles the depth-first search closes, in the order it closes them: each edge back to a node still on the search
   * path gives the route from that node down the path and back to it. Each route lies inside one component; a component
   * with several back edges has several routes.
   */
  readonly routes: readonly (readonly string[])[]
}

interface Frame {
  readonly name: string
  /** The index of the next successor to follow. */
  next: number
}

/**
 * Tarjan's strongly connected components, iterative so that a long chain of packages cannot exhaust the stack. The
 * search starts from `roots` in order and follows each node's `successors` in order, so components and routes are
 * deterministic.
 */
export const stronglyConnectedComponents = (roots: readonly string[], successors: ReadonlyMap<string, readonly string[]>): Components => {
  const index = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  // The search path: the frames of the nodes being searched, and where each of their names sits among them.
  const frames: Frame[] = []
  const pathPosition = new Map<string, number>()
  const components: string[][] = []
  const routes: string[][] = []

  const enter = (name: string) => {
    const order = index.size
    index.set(name, order)
    lowLink.set(name, order)
    stack.push(name)
    onStack.add(name)
    pathPosition.set(name, frames.length)
    frames.push({ name, next: 0 })
  }

  for (const root of roots) {
    if (index.has(root)) {
      continue
    }

    enter(root)

    for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
      const targets = successors.get(frame.name) ?? []
      const target = targets[frame.next]

      if (target !== undefined) {
        frame.next += 1

        if (!index.has(target)) {
          enter(target)
        } else if (onStack.has(target)) {
          lowLink.set(frame.name, Math.min(lowLink.get(frame.name) ?? 0, index.get(target) ?? 0))
          const position = pathPosition.get(target)

          if (position !== undefined) {
            routes.push([...frames.slice(position).map((onPath) => onPath.name), target])
          }
        }

        continue
      }

      frames.pop()
      pathPosition.delete(frame.name)
      const link = lowLink.get(frame.name) ?? 0

      if (link === index.get(frame.name)) {
        const component: string[] = []

        for (let member = stack.pop(); member !== undefined; member = member === frame.name ? undefined : stack.pop()) {
          onStack.delete(member)
          component.push(member)
        }

        components.push(component)
      }

      const parent = frames.at(-1)

      if (parent !== undefined) {
        lowLink.set(parent.name, Math.min(lowLink.get(parent.name) ?? 0, link))
      }
    }
  }

  return { components, routes }
}

/**
 * Cycles between workspace packages through their runtime dependency fields. Every route the search closes is a
 * finding, once per set of packages, starting at the package the search reached first; so a component with several
 * cycles can have several findings.
 */
const packageCycles = (engine: Engine): Finding[] => {
  const { workspace } = engine
  const edges = new Map(
    workspace.packages.map((entry) => [
      entry.name,
      [...new Set(runtimeFields.flatMap((field) => entry.manifest[field]))].filter((name) => workspace.byName.has(name) && name !== entry.name),
    ]),
  )
  const findings: Finding[] = []
  const seen = new Set<string>()

  for (const cycle of stronglyConnectedComponents([...edges.keys()].toSorted(), edges).routes) {
    const key = cycle.slice(0, -1).toSorted().join(" ")

    if (!seen.has(key)) {
      seen.add(key)
      const first = cycle[0] ?? ""
      findings.push({
        rule: "package-cycle",
        file: `${workspace.byName.get(first)?.directory ?? first}/package.json`,
        line: 1,
        column: 0,
        message: `dependency cycle: ${cycle.join(" -> ")}`,
        target: key,
      })
    }
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
