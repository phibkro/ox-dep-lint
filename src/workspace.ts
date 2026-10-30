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
}

export interface Workspace {
  /** Absolute path of the repository root (the directory whose `package.json` declares `workspaces`). */
  readonly root: string
  readonly packages: readonly WorkspacePackage[]
  readonly byName: ReadonlyMap<string, WorkspacePackage>
  /** The root package's own dependency fields. */
  readonly rootManifest: Readonly<Record<ManifestField, readonly string[]>>
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
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} is not a JSON object`)
  }

  return parsed
}

const namesOf = (field: unknown): readonly string[] => (typeof field === "object" && field !== null ? Object.keys(field).toSorted() : [])

const fieldsOf = (manifest: Manifest): Record<ManifestField, readonly string[]> => ({
  dependencies: namesOf(manifest.dependencies),
  devDependencies: namesOf(manifest.devDependencies),
  optionalDependencies: namesOf(manifest.optionalDependencies),
  peerDependencies: namesOf(manifest.peerDependencies),
})

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

/** The nearest directory at or above `start` whose `package.json` declares `workspaces`. */
export const findWorkspaceRoot = (start: string): string | undefined => {
  let directory = nodePath.resolve(start)

  for (;;) {
    const manifest = nodePath.join(directory, "package.json")

    if (existsSync(manifest) && workspaceGlobs(readManifest(manifest)) !== undefined) {
      return directory
    }

    const parent = nodePath.dirname(directory)

    if (parent === directory) {
      return undefined
    }

    directory = parent
  }
}

/** Directories under `root` (relative, `/`-separated) that a workspace glob names, skipping `node_modules` and dot directories. */
const expand = (root: string, pattern: string): string[] => {
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
    for (const directory of expand(root, pattern)) {
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

  const packages = [...directories].toSorted().map((directory): WorkspacePackage => {
    const manifest = readManifest(nodePath.join(root, directory, "package.json"))

    if (typeof manifest.name !== "string") {
      throw new TypeError(`${directory}/package.json has no name`)
    }

    return { name: manifest.name, directory, manifest: fieldsOf(manifest) }
  })

  return {
    root,
    packages,
    byName: new Map(packages.map((entry) => [entry.name, entry])),
    rootManifest: fieldsOf(rootManifest),
  }
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
