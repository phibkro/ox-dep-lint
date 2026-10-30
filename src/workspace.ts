/**
 * The workspace as `package.json` files declare it: the root's `workspaces` globs, and each package's real name (never
 * guessed from its directory) and dependency fields.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
import nodePath from "node:path"
import { allManifestFields } from "./config.ts"
import type { ManifestField } from "./config.ts"
import { matchesGlob } from "./glob.ts"
import { attempt, codeOf, failure, messageOf, success, vanished } from "./result.ts"
import type { Result } from "./result.ts"

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
  /**
   * Members whose package.json is wrong. With no name, a name another member has, or a package.json that cannot be read,
   * the member cannot be checked and is not in `packages`; with a dependency field that is not an object, it is, as if
   * that field declared nothing.
   */
  readonly problems: readonly { readonly directory: string; readonly message: string }[]
  /** The root package.json's `workspaces` globs, negations (`!apps/old`) included. */
  readonly globs: readonly string[]
}

interface Manifest {
  readonly name?: unknown
  readonly workspaces?: unknown
  readonly dependencies?: unknown
  readonly devDependencies?: unknown
  readonly optionalDependencies?: unknown
  readonly peerDependencies?: unknown
}

/** Why a manifest cannot be read, and whether that is because it is no longer there (removed since it was found). */
interface ManifestFailure {
  readonly message: string
  readonly vanished: boolean
}

/** The manifest at `path`, or why it cannot be read. */
const readManifest = (path: string): Result<Manifest, ManifestFailure> => {
  const text = attempt(() => readFileSync(path, "utf8"))

  if (!text.ok) {
    return failure({ message: `${path}: ${messageOf(text.error)}`, vanished: vanished(text.error) })
  }

  const parsed = attempt((): unknown => JSON.parse(text.value))

  if (!parsed.ok) {
    return failure({ message: `${path}: ${messageOf(parsed.error)}`, vanished: false })
  }

  if (typeof parsed.value !== "object" || parsed.value === null) {
    return failure({ message: `${path} is not a JSON object`, vanished: false })
  }

  return success(parsed.value)
}

/** Whether a dependency field has the shape npm and Bun require: an object of package names to version ranges. */
const isRecord = (field: unknown): field is object => typeof field === "object" && field !== null && !Array.isArray(field)

const namesOf = (field: unknown): readonly string[] => (isRecord(field) ? Object.keys(field).toSorted() : [])

/**
 * A message for each dependency field of `manifest` that is present and not an object (`"dependencies": "x"`, a list, a
 * number, null). Such a field declares nothing the check can read, so without a finding its edges would pass unseen.
 */
const malformedFields = (manifest: Manifest): string[] =>
  allManifestFields
    .filter((field) => manifest[field] !== undefined && !isRecord(manifest[field]))
    .map((field) => {
      const value = manifest[field]
      const described = value === null ? "null" : Array.isArray(value) ? "a list" : `a ${typeof value}`

      return `${field} is ${described}, not an object of package names to version ranges, so no dependency in it is read`
    })

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
    if (isRecord(field)) {
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

const workspacesOf = (path: string): readonly string[] => {
  const manifest = readManifest(path)

  return manifest.ok ? (workspaceGlobs(manifest.value) ?? []) : []
}

/** Whether `globs` (from the manifest in `candidate`) hold `directory`: one of them matches it or a directory above it. */
const holds = (candidate: string, globs: readonly string[], directory: string): boolean => {
  const parts = nodePath
    .relative(candidate, directory)
    .split(nodePath.sep)
    .filter((part) => part !== "")

  return parts.some((_, index) => {
    const prefix = parts.slice(0, index + 1).join("/")

    return globs.some((glob) => matchesGlob(prefix, glob.replace(/^\.\//u, "").replace(/\/$/u, "")))
  })
}

/**
 * The workspace root for a file in `start`. The nearest directory whose `package.json` `workspaces` hold `start` is a
 * root; while a manifest further up holds that root in turn (a member that declares workspaces of its own), the root
 * moves up to it. With no manifest holding `start`, the nearest one with any workspaces. So a worktree kept inside
 * another checkout is its own workspace, and a nested member or a git submodule belongs to the workspace that lists it.
 */
export const findWorkspaceRoot = (start: string): string | undefined => {
  const directory = nodePath.resolve(start)
  let nearest: string | undefined
  let root: string | undefined

  for (let candidate = directory; ; candidate = nodePath.dirname(candidate)) {
    const globs = workspacesOf(nodePath.join(candidate, "package.json")).filter((glob) => !glob.startsWith("!"))

    if (globs.length > 0) {
      nearest ??= candidate

      if (candidate === directory || holds(candidate, globs, root ?? directory)) {
        root = candidate
      }
    }

    if (nodePath.dirname(candidate) === candidate) {
      return root ?? nearest
    }
  }
}

/** The first of `path`'s directories (repository-relative), itself included, that is a symbolic link. */
const linkAlong = (root: string, path: string): string | undefined => {
  const parts = path === "" ? [] : path.split("/")

  return parts
    .map((_, index) => parts.slice(0, index + 1).join("/"))
    .find((prefix) => {
      const status = attempt(() => lstatSync(nodePath.join(root, prefix)))

      return status.ok && status.value.isSymbolicLink()
    })
}

/**
 * What `directoriesMatching` met and did not descend into: symbolic links the pattern matches or passes through,
 * directories it could not list, and dot directories it matches (other than `.git`), which workspaces globs never match.
 */
export interface Unlisted {
  readonly links: string[]
  readonly unreadable: { readonly directory: string; readonly code: string }[]
  readonly dotDirectories: string[]
}

/**
 * The directories under `root` that `pattern` matches, skipping `node_modules` and dot directories, as npm and Bun
 * workspaces do. A symbolic link is never followed, not even one the pattern names literally or passes through (a
 * `packages` that is a link), and a directory that cannot be listed is passed over; with `unlisted`, those and the dot
 * directories the pattern would match are collected there, so the caller can report them.
 */
export const directoriesMatching = (root: string, pattern: string, unlisted?: Unlisted): string[] => {
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

    const listed = attempt(() => readdirSync(nodePath.join(root, relative), { withFileTypes: true }))

    if (!listed.ok) {
      // Removed (or replaced by a file) since it was found: nothing is left to list or report.
      if (!vanished(listed.error)) {
        unlisted?.unreadable.push({ directory: relative, code: codeOf(listed.error) })
      }

      return
    }

    for (const entry of listed.value) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`

      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        walk(path, depth + 1)
      } else if (entry.isDirectory() && entry.name.startsWith(".") && entry.name !== ".git" && matchesGlob(path, clean)) {
        unlisted?.dotDirectories.push(path)
      } else if (entry.isSymbolicLink() && matchesGlob(path, clean)) {
        unlisted?.links.push(path)
      }
    }
  }

  const link = linkAlong(root, base)

  if (link !== undefined) {
    unlisted?.links.push(link)

    return []
  }

  if (base === clean) {
    return existsSync(nodePath.join(root, base)) ? [base] : []
  }

  // One look rather than `existsSync` then `statSync`, so a base removed in between is no error.
  const status = attempt(() => statSync(nodePath.join(root, base)))

  if (status.ok && status.value.isDirectory()) {
    walk(base, base === "" ? 0 : base.split("/").length)
  }

  return found
}

export const loadWorkspace = (root: string): Workspace => {
  const rootRead = readManifest(nodePath.join(root, "package.json"))

  if (!rootRead.ok) {
    throw new Error(rootRead.error.message)
  }

  const rootManifest = rootRead.value
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
    const read = readManifest(nodePath.join(root, directory, "package.json"))

    // A member removed since the glob found it is no member; one whose package.json cannot be read for another reason is a finding.
    if (!read.ok && read.error.vanished) {
      continue
    }

    if (!read.ok) {
      problems.push({ directory, message: `package.json cannot be read: ${read.error.message}` })
      continue
    }

    const manifest = read.value

    if (typeof manifest.name !== "string" || manifest.name === "") {
      problems.push({ directory, message: "package.json has no name, so nothing can import it and its kind cannot be known" })
      continue
    }

    const other = byName.get(manifest.name)

    if (other !== undefined) {
      problems.push({ directory, message: `${manifest.name} is also the name of ${other.directory}` })
      continue
    }

    for (const message of malformedFields(manifest)) {
      problems.push({ directory, message })
    }

    const entry = { name: manifest.name, directory, manifest: fieldsOf(manifest), aliases: aliasesOf(manifest) }
    packages.push(entry)
    byName.set(entry.name, entry)
  }

  return { root, packages, byName, rootManifest: fieldsOf(rootManifest), problems, globs }
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
