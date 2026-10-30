/**
 * The workspace as `package.json` files declare it: the root's `workspaces` globs, and each package's real name (never
 * guessed from its directory) and dependency fields.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import nodePath from "node:path"
import type { ManifestField } from "./config.ts"
import { matchesGlob } from "./glob.ts"

export interface WorkspacePackage {
  readonly name: string
  /** Repository-relative directory, `/`-separated (`libraries/parcel`). */
  readonly directory: string
  readonly manifest: Readonly<Record<ManifestField, readonly string[]>>
  /** Dependencies declared as `npm:` aliases, by declared name, with the package each installs. */
  readonly aliases: ReadonlyMap<string, string>
}

export interface Workspace {
  /** Absolute path of the repository root (the directory whose `package.json` declares `workspaces`). */
  readonly root: string
  readonly packages: readonly WorkspacePackage[]
  readonly byName: ReadonlyMap<string, WorkspacePackage>
  /** The root package's own dependency fields. */
  readonly rootManifest: Readonly<Record<ManifestField, readonly string[]>>
  /** Members that cannot be checked: no name, a name another member has, an unreadable package.json. */
  readonly problems: readonly { readonly directory: string; readonly message: string }[]
}

interface Manifest {
  readonly name?: unknown
  readonly workspaces?: unknown
  readonly dependencies?: unknown
  readonly devDependencies?: unknown
  readonly optionalDependencies?: unknown
  readonly peerDependencies?: unknown
}

const readManifest = (path: string): Manifest => {
  let parsed: unknown

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (cause) {
    throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} is not a JSON object`)
  }

  return parsed
}

const namesOf = (field: unknown): readonly string[] =>
  typeof field === "object" && field !== null && !Array.isArray(field) ? Object.keys(field).toSorted() : []

const fieldsOf = (manifest: Manifest): Record<ManifestField, readonly string[]> => ({
  dependencies: namesOf(manifest.dependencies),
  devDependencies: namesOf(manifest.devDependencies),
  optionalDependencies: namesOf(manifest.optionalDependencies),
  peerDependencies: namesOf(manifest.peerDependencies),
})

/** `{ vite: "@voidzero-dev/vite-plus-core" }` for `"vite": "npm:@voidzero-dev/vite-plus-core@1"`. */
const aliasesOf = (manifest: Manifest): Map<string, string> => {
  const aliases = new Map<string, string>()

  for (const field of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
    if (typeof field === "object" && field !== null && !Array.isArray(field)) {
      for (const [name, spec] of Object.entries(field)) {
        const target = typeof spec === "string" ? /^npm:(?<target>@?[^@]+)/u.exec(spec)?.groups?.target : undefined

        if (target !== undefined) {
          aliases.set(name, target)
        }
      }
    }
  }

  return aliases
}

const workspaceGlobs = (manifest: Manifest): readonly string[] | undefined => {
  const field = manifest.workspaces

  if (Array.isArray(field)) {
    return field.filter((entry): entry is string => typeof entry === "string")
  }

  if (typeof field === "object" && field !== null && "packages" in field && Array.isArray(field.packages)) {
    return field.packages.filter((entry): entry is string => typeof entry === "string")
  }

  return undefined
}

const workspacesOf = (manifest: string): readonly string[] => {
  try {
    return workspaceGlobs(readManifest(manifest)) ?? []
  } catch {
    return []
  }
}

/**
 * The workspace root for a file in `start`: the nearest directory at or above it whose `package.json` declares
 * workspaces that hold `start` (one of its globs matches `start` or a directory above it), else the nearest one with
 * any workspaces at all. Nearest, so a worktree kept inside another checkout is its own workspace; holding, so a git
 * submodule or a member with its own stray `workspaces` still belongs to the workspace that lists it.
 */
export const findWorkspaceRoot = (start: string): string | undefined => {
  const directory = nodePath.resolve(start)
  let nearest: string | undefined

  for (let candidate = directory; ; candidate = nodePath.dirname(candidate)) {
    const globs = workspacesOf(nodePath.join(candidate, "package.json")).filter((glob) => !glob.startsWith("!"))

    if (globs.length > 0) {
      nearest ??= candidate
      const parts = nodePath
        .relative(candidate, directory)
        .split(nodePath.sep)
        .filter((part) => part !== "")
      const holds = parts.some((_, index) => {
        const prefix = parts.slice(0, index + 1).join("/")

        return globs.some((glob) => matchesGlob(prefix, glob.replace(/^\.\//u, "").replace(/\/$/u, "")))
      })

      if (holds || parts.length === 0) {
        return candidate
      }
    }

    if (nodePath.dirname(candidate) === candidate) {
      return nearest
    }
  }
}

export const directoriesMatching = (root: string, pattern: string): string[] => {
  const negated = pattern.startsWith("!")
  const clean = (negated ? pattern.slice(1) : pattern).replace(/^\.\//u, "").replace(/\/$/u, "")
  const fixed: string[] = []

  for (const segment of clean.split("/")) {
    if (/[*?{]/u.test(segment)) {
      break
    }

    fixed.push(segment)
  }

  const base = fixed.join("/")
  const found: string[] = []
  const depthLimit = clean.includes("**") ? Number.POSITIVE_INFINITY : clean.split("/").length

  const walk = (relative: string, depth: number) => {
    if (matchesGlob(relative, clean)) {
      found.push(relative)
    }

    if (depth >= depthLimit) {
      return
    }

    const absolute = nodePath.join(root, relative)

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        walk(relative === "" ? entry.name : `${relative}/${entry.name}`, depth + 1)
      }
    }
  }

  if (base === clean) {
    return existsSync(nodePath.join(root, base)) ? [base] : []
  }

  if (existsSync(nodePath.join(root, base)) && statSync(nodePath.join(root, base)).isDirectory()) {
    walk(base, base === "" ? 0 : base.split("/").length)
  }

  return found
}

export const loadWorkspace = (root: string): Workspace => {
  const rootManifest = readManifest(nodePath.join(root, "package.json"))
  const globs = workspaceGlobs(rootManifest) ?? []
  const directories = new Set<string>()

  for (const pattern of globs.filter((glob) => !glob.startsWith("!"))) {
    for (const directory of directoriesMatching(root, pattern)) {
      if (existsSync(nodePath.join(root, directory, "package.json"))) {
        directories.add(directory)
      }
    }
  }

  for (const pattern of globs.filter((glob) => glob.startsWith("!"))) {
    for (const directory of directories) {
      if (matchesGlob(directory, pattern.slice(1).replace(/^\.\//u, ""))) {
        directories.delete(directory)
      }
    }
  }

  const packages: WorkspacePackage[] = []
  const problems: { directory: string; message: string }[] = []
  const byName = new Map<string, WorkspacePackage>()

  for (const directory of [...directories].toSorted()) {
    let manifest: Manifest

    try {
      manifest = readManifest(nodePath.join(root, directory, "package.json"))
    } catch (error) {
      problems.push({ directory, message: `package.json cannot be read: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }

    if (typeof manifest.name !== "string" || manifest.name === "") {
      problems.push({ directory, message: "package.json has no name, so nothing can import it and its kind cannot be known" })
      continue
    }

    const other = byName.get(manifest.name)

    if (other !== undefined) {
      problems.push({ directory, message: `${manifest.name} is also the name of ${other.directory}` })
      continue
    }

    const entry = { name: manifest.name, directory, manifest: fieldsOf(manifest), aliases: aliasesOf(manifest) }
    packages.push(entry)
    byName.set(entry.name, entry)
  }

  return { root, packages, byName, rootManifest: fieldsOf(rootManifest), problems }
}

/** The package whose directory holds the repository-relative `file`, the deepest one when packages nest. */
export const packageOfFile = (workspace: Workspace, file: string): WorkspacePackage | undefined => {
  let best: WorkspacePackage | undefined

  for (const candidate of workspace.packages) {
    if (file.startsWith(`${candidate.directory}/`) && (best === undefined || candidate.directory.length > best.directory.length)) {
      best = candidate
    }
  }

  return best
}

/** `@scope/name/sub` is `@scope/name`; `name/sub` is `name`. */
export const packageNameOf = (specifier: string): string => {
  const parts = specifier.split("/")

  return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/")
}
