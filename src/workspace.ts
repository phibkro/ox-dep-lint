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
  /** Dependency names declared as `npm:` aliases (`"vite": "npm:@voidzero-dev/vite-plus-core@1"`). */
  readonly aliases: ReadonlySet<string>
}

export interface Workspace {
  /** Absolute path of the repository root (the directory whose `package.json` declares `workspaces`). */
  readonly root: string
  readonly packages: readonly WorkspacePackage[]
  readonly byName: ReadonlyMap<string, WorkspacePackage>
  /** The root package's own dependency fields. */
  readonly rootManifest: Readonly<Record<ManifestField, readonly string[]>>
  readonly rootAliases: ReadonlySet<string>
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

const aliasesOf = (manifest: Manifest): Set<string> => {
  const aliases = new Set<string>()

  for (const field of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
    if (typeof field === "object" && field !== null && !Array.isArray(field)) {
      for (const [name, spec] of Object.entries(field)) {
        if (typeof spec === "string" && spec.startsWith("npm:")) {
          aliases.add(name)
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

const declaresWorkspaces = (manifest: string): boolean => {
  try {
    return (workspaceGlobs(readManifest(manifest))?.length ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * The nearest directory at or above `start` whose `package.json` declares a non-empty `workspaces`, without leaving the
 * repository `start` is in (a directory holding `.git`, a worktree's `.git` file included). Nearest, so a worktree
 * kept inside another checkout is its own workspace; non-empty, so a member with a stray `"workspaces": []` cannot
 * make itself the root of an empty workspace.
 */
export const findWorkspaceRoot = (start: string): string | undefined => {
  let directory = nodePath.resolve(start)

  for (;;) {
    if (declaresWorkspaces(nodePath.join(directory, "package.json"))) {
      return directory
    }

    const parent = nodePath.dirname(directory)

    if (parent === directory || existsSync(nodePath.join(directory, ".git"))) {
      return undefined
    }

    directory = parent
  }
}

/** Directories under `root` (relative, `/`-separated) that a workspace glob names, skipping `node_modules` and dot directories. */
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

  return { root, packages, byName, rootManifest: fieldsOf(rootManifest), rootAliases: aliasesOf(rootManifest), problems }
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
