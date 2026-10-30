/**
 * One engine for both front ends: the oxlint rule calls `findingsForFile` per file for editor feedback, and the CLI calls
 * it over every file and adds the whole-graph checks (`graph.ts`), so the two never disagree. Rules adapted from the
 * module graph checks of phibkro/file-transfer, phibkro/vektorprogrammet-reimagined and reebeat/reebeat.
 */
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import nodePath from "node:path"
import { resolveConfig } from "./config.ts"
import type { BaselineEntry, Config, FilePolicy, ManifestField, ResolvedConfig, RuleName } from "./config.ts"
import { matchesAny, matchesGlob } from "./glob.ts"
import { isRuntimeModule, makeResolver, withoutQuery } from "./resolve.ts"
import type { Resolver, Target } from "./resolve.ts"
import { attempt, codeOf } from "./result.ts"
import { importForms } from "./specifiers.ts"
import { loadWorkspace, packageNameOf, packageOfFile } from "./workspace.ts"
import type { Workspace, WorkspacePackage } from "./workspace.ts"

const nodeModules = ["node:module", ...builtinModules]

/**
 * Packages that hold a runtime's types, and the runtime modules they describe: the package counts as the runtime when
 * the configuration names any of them a runtime module (Node's by its `node:` prefix or any bare built-in).
 */
const runtimeTypePackages: Readonly<Record<string, readonly string[]>> = {
  node: nodeModules,
  "@types/node": nodeModules,
  bun: ["bun"],
  "bun-types": ["bun"],
  "@types/bun": ["bun"],
  "@cloudflare/workers-types": ["cloudflare:workers"],
}

export interface Finding {
  readonly rule: RuleName
  /** Repository-relative file. */
  readonly file: string
  readonly line: number
  readonly column: number
  readonly message: string
  /** The specifier or package the finding names, for baseline matching. */
  readonly target?: string
  /** Offsets of the text the finding is about, in the source without a byte order mark. */
  readonly start?: number
  readonly end?: number
}

export interface Engine {
  readonly workspace: Workspace
  readonly config: ResolvedConfig
  readonly resolver: Resolver
  /** The kind of a workspace package, or undefined when no kind's globs match its directory. */
  readonly kindOf: (entry: WorkspacePackage) => string | undefined
  /** What each development file would break if it shipped, with the files that verdict read and their modification times. */
  readonly developmentVerdicts: Map<string, { readonly read: ReadonlyMap<string, number>; readonly breaks: string | undefined }>
}

/** The source files the engine reads; anything else (`.vue`, `.json`) is no finding in either front end. */
export const sourceFile = /\.[cm]?[jt]sx?$/u

export const createEngine = (root: string, config: Config): Engine => {
  const resolved = resolveConfig(config)
  const workspace = loadWorkspace(root)
  const kinds = new Map<string, string | undefined>()

  for (const entry of workspace.packages) {
    kinds.set(entry.directory, Object.entries(resolved.kinds).find(([, kind]) => matchesAny(entry.directory, kind.packages))?.[0])
  }

  return {
    workspace,
    config: resolved,
    resolver: makeResolver(workspace, resolved),
    kindOf: (entry) => kinds.get(entry.directory),
    developmentVerdicts: new Map(),
  }
}

/** The policy of a package-relative file: the first file class that matches, else shipped. */
export const policyOf = (config: ResolvedConfig, packageRelative: string): FilePolicy =>
  config.fileClasses.find((fileClass) => matchesAny(packageRelative, fileClass.files))?.policy ?? "shipped"

/** The policy a file is checked under: its class, with a package's test-support files counted as development files. */
export const effectivePolicy = (engine: Engine, owner: WorkspacePackage, packageRelative: string): FilePolicy => {
  const policy = policyOf(engine.config, packageRelative)

  return policy === "shipped" && matchesAny(packageRelative, engine.config.packages[owner.name]?.testSupportFiles ?? []) ? "development" : policy
}

const article = (word: string) => (/^[aeiou]/iu.test(word) ? `an ${word}` : `a ${word}`)

/** Whether `entry` declares `name` in `fields`, or (when `anywhere`) in any field of its own or the root's. */
const declares = (engine: Engine, entry: WorkspacePackage, name: string, anywhere: boolean): boolean => {
  const fields: readonly ManifestField[] = engine.config.imports.shippedFields

  if (fields.some((field) => entry.manifest[field].includes(name))) {
    return true
  }

  return (
    anywhere &&
    (Object.values(entry.manifest).some((names) => names.includes(name)) || Object.values(engine.workspace.rootManifest).some((names) => names.includes(name)))
  )
}

/** `@types/scope__name` for `@scope/name`, `@types/name` for `name`. */
const typesPackage = (name: string) => `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`

/** Why `from` may not import workspace package `to` (written as `specifier`), or undefined when it may. */
export const edgeRefusal = (
  engine: Engine,
  from: WorkspacePackage,
  to: WorkspacePackage,
  typeOnly: boolean,
  specifier?: string,
): { rule: RuleName; why: string } | undefined => {
  const kind = engine.kindOf(from)
  const targetKind = engine.kindOf(to)
  const refinements = engine.config.packages[from.name]

  if (kind === undefined || targetKind === undefined) {
    return undefined
  }

  if (refinements?.typeOnlyUses?.includes(to.name) === true) {
    const valueAllowed = specifier !== undefined && matchesAny(specifier, refinements.valueSpecifiers ?? [])

    return typeOnly || valueAllowed ? undefined : { rule: "type-only-edge", why: `${from.name} may import ${to.name} only with import type or export type` }
  }

  const rule = engine.config.kinds[kind]

  if (rule !== undefined && rule.mayUse !== "any" && !rule.mayUse.includes(targetKind)) {
    return { rule: "forbidden-edge", why: `${article(kind)} package may not import ${to.name}, ${article(targetKind)}` }
  }

  if (refinements?.uses !== undefined && !refinements.uses.includes(to.name)) {
    return { rule: "forbidden-edge", why: `${from.name} may import only ${refinements.uses.join(", ") || "no workspace package"}, not ${to.name}` }
  }

  return undefined
}

/** Whether the engine reads `file` at all: a source file of a workspace package, not ignored, not build output. */
export const reads = (engine: Engine, file: string): boolean => {
  if (!sourceFile.test(file) || matchesAny(file, engine.config.ignore)) {
    return false
  }

  const owner = packageOfFile(engine.workspace, file)

  return owner !== undefined && !matchesAny(file.slice(owner.directory.length + 1), engine.config.output)
}

/** Whether `glob` matches every path under `directory`: it is `**`, or it or a directory above it matches what comes before a trailing `/**`. */
export const coversDirectory = (glob: string, directory: string): boolean => {
  if (glob === "**") {
    return true
  }

  if (!glob.endsWith("/**") || directory === "") {
    return false
  }

  const parts = directory.split("/")

  return parts.some((_, index) => matchesGlob(parts.slice(0, index + 1).join("/"), glob.slice(0, -3)))
}

/**
 * Whether `glob` might match a path under `directory`: its leading segments agree with the directory's until a `**`,
 * and it is longer than the directory. A glob with braces is taken to match, so a doubt counts as a match.
 */
const mayMatchUnder = (glob: string, directory: string): boolean => {
  if (glob.includes("{")) {
    return true
  }

  const globParts = glob.split("/")
  const directoryParts = directory === "" ? [] : directory.split("/")

  for (const [index, part] of directoryParts.entries()) {
    const globPart = globParts[index]

    if (globPart === undefined) {
      return false
    }

    if (globPart === "**") {
      return true
    }

    if (!matchesGlob(part, globPart)) {
      return false
    }
  }

  return globParts.length > directoryParts.length
}

/** Whether an `ignore` glob covers every file under the repository-relative `directory`. */
export const ignoresDirectory = (engine: Engine, directory: string): boolean => engine.config.ignore.some((glob) => coversDirectory(glob, directory))

/**
 * Whether the check reads no file under the repository-relative `directory`, so a symbolic link or an unreadable
 * directory there hides nothing: an `ignore` glob covers it, or (relative to the package that owns it) an `output` glob
 * or an unchecked file class does, with no earlier class that might match a file in it. A glob covers a directory only
 * through a trailing `/**`; any doubt counts as read, so the answer errs towards a finding.
 */
export const skipsDirectory = (engine: Engine, directory: string): boolean => {
  const { config } = engine

  if (ignoresDirectory(engine, directory)) {
    return true
  }

  const owner = packageOfFile(engine.workspace, `${directory}/`)

  if (owner === undefined) {
    return true
  }

  const relative = directory.slice(owner.directory.length + 1)

  if (config.output.some((glob) => coversDirectory(glob, relative))) {
    return true
  }

  for (const fileClass of config.fileClasses) {
    if (fileClass.files.some((glob) => coversDirectory(glob, relative))) {
      return fileClass.policy === "unchecked"
    }

    if (fileClass.policy !== "unchecked" && fileClass.files.some((glob) => mayMatchUnder(glob, relative))) {
      return false
    }
  }

  return false
}

/** Directories the walk never enters, wherever they are: dependencies and git's own data. */
export const passedOver = (name: string): boolean => name === "node_modules" || name === ".git"

/**
 * Whether a symbolic link at the repository-relative `path` is a finding: always, whatever it points at, unless it lies
 * in (or is) a directory the check skips on purpose (`node_modules`, `.git`, or one `skipsDirectory` covers).
 */
export const reportsLink = (engine: Engine, path: string): boolean => !path.split("/").some(passedOver) && !skipsDirectory(engine, path)

/** A symbolic link the check met and did not follow, at `path` (repository-relative), with the destination it names. */
export const symbolicLinkFinding = (path: string, destination: string): Finding => ({
  rule: "symbolic-link",
  file: path,
  line: 1,
  column: 0,
  message: `${path} is a symbolic link to ${destination}, which the check never follows, so what it reaches goes unchecked: replace it with the files themselves, or baseline it`,
  target: destination,
})

/** A directory the check needed to list, or a source file it needed to read, and could not, with the error code that said why. */
export const unreadablePathFinding = (path: string, code: string, kind: "directory" | "file" = "directory"): Finding => ({
  rule: "unreadable-path",
  file: path,
  line: 1,
  column: 0,
  message:
    kind === "directory"
      ? `${path} cannot be read (${code}), so the files in it cannot be checked: make it readable, or add ${path}/** to ignore`
      : `${path} cannot be read (${code}), so its imports cannot be checked: make it readable, or add it to ignore`,
  target: path,
})

/** The destination a symbolic link names, as written. */
export const linkDestination = (absolute: string): string => {
  try {
    return readlinkSync(absolute)
  } catch {
    return "an unreadable destination"
  }
}

/**
 * The first symbolic link on the way from `owner`'s directory down to `file` (both repository-relative), the file
 * itself included. The CLI's walk never follows one, but oxlint does, and lints the files behind it under the link's
 * path.
 */
const linkOnPath = (engine: Engine, owner: WorkspacePackage, file: string): string | undefined => {
  const parts = file.slice(owner.directory.length + 1).split("/")

  for (const [index] of parts.entries()) {
    const path = [owner.directory, ...parts.slice(0, index + 1)].join("/")

    try {
      if (lstatSync(nodePath.join(engine.workspace.root, path)).isSymbolicLink()) {
        return path
      }
    } catch {
      return undefined
    }
  }

  return undefined
}

/** The rules that hold for shipped code and not for development files. */
const shippedOnlyRules: ReadonlySet<RuleName> = new Set([
  "runtime-module",
  "test-only-in-shipped",
  "forbidden-external",
  "undeclared-import",
  "computed-import",
  "shipped-imports-development-file",
])

const modifiedTime = (absolute: string): number | undefined => {
  try {
    return statSync(absolute).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * What the development file `file` would break if it shipped, or undefined when it is fit to ship. It breaks when it,
 * or any development file it reaches through further development files, has a finding that holds only for shipped
 * code. Shipped code may import a development file (a shared helper under `scripts/`, a package-root config) only while
 * this holds, so a test helper cannot launder `node:fs` or `fast-check` into shipped code. A breadth-first walk, so
 * cycles and long chains of development files end; the verdict is kept until any file it read changes.
 */
export const developmentFileBreaks = (engine: Engine, file: string): string | undefined => {
  const known = engine.developmentVerdicts.get(file)

  if (known !== undefined && [...known.read].every(([path, time]) => modifiedTime(nodePath.join(engine.workspace.root, path)) === time)) {
    return known.breaks
  }

  const read = new Map<string, number>()
  // A queue read from a head index: `shift()` copies the rest of the array, which made long chains quadratic.
  const queue = [file]
  let head = 0
  let breaks: string | undefined

  while (head < queue.length && breaks === undefined) {
    const next = queue[head] ?? file
    head += 1
    const absolute = nodePath.join(engine.workspace.root, next)
    const time = modifiedTime(absolute)

    if (read.has(next) || time === undefined) {
      continue
    }

    read.set(next, time)
    // The directory too: a file added beside it can change what its imports resolve to.
    const directory = nodePath.dirname(next)
    read.set(directory, modifiedTime(nodePath.join(engine.workspace.root, directory)) ?? -1)
    const reached: string[] = []
    const text = attempt(() => readFileSync(absolute, "utf8"))

    if (!text.ok) {
      breaks = `${next} cannot be read (${codeOf(text.error)}), so it cannot be judged`
      break
    }

    const finding = findingsForFile(engine, next, text.value, { developmentImports: reached }).find((candidate) => shippedOnlyRules.has(candidate.rule))

    if (finding !== undefined) {
      breaks = `${next === file ? "" : `through ${next}, `}${finding.rule} at line ${finding.line}: ${finding.message}`
    }

    queue.push(...reached)
  }

  engine.developmentVerdicts.set(file, { read, breaks })

  return breaks
}

/**
 * Every finding for one file, before the baseline. `file` is repository-relative and `text` is its source. With
 * `developmentImports`, the file is checked as if it shipped, and the development files it imports are collected there
 * instead of judged (see `developmentFileBreaks`).
 */
export const findingsForFile = (engine: Engine, file: string, text: string, options: { readonly developmentImports?: string[] } = {}): Finding[] => {
  const { developmentImports } = options
  const asShipped = developmentImports !== undefined
  const { config, workspace } = engine
  const owner = packageOfFile(workspace, file)

  // A file the check does not read (build output, an ignored path) is still judged when shipped code imports it.
  if (owner === undefined || !sourceFile.test(file)) {
    return []
  }

  // Reached through a symbolic link (only oxlint does that): the link is the finding, and nothing behind it is read.
  const link = linkOnPath(engine, owner, file)

  if (link !== undefined) {
    return reportsLink(engine, link) ? [symbolicLinkFinding(link, linkDestination(nodePath.join(workspace.root, link)))] : []
  }

  if (!reads(engine, file) && developmentImports === undefined) {
    return []
  }

  const packageRelative = file.slice(owner.directory.length + 1)
  const classified = effectivePolicy(engine, owner, packageRelative)
  const policy = asShipped ? "shipped" : classified

  if (policy === "unchecked") {
    return []
  }

  const findings: Finding[] = []
  const kind = engine.kindOf(owner)

  const report = (rule: RuleName, place: { line: number; column: number; start?: number; end?: number }, message: string, target?: string) => {
    const where =
      place.start === undefined || place.end === undefined
        ? { line: place.line, column: place.column }
        : { line: place.line, column: place.column, start: place.start, end: place.end }
    findings.push(target === undefined ? { rule, file, ...where, message } : { rule, file, ...where, message, target })
  }

  if (kind === undefined) {
    report("package-without-kind", { line: 1, column: 0 }, `${owner.name} (${owner.directory}) matches no kind: add its directory to one`, owner.name)

    return findings
  }

  const kindRule = config.kinds[kind]
  const refinements = config.packages[owner.name]
  const shipped = policy === "shipped"
  const forms = importForms(file, text)

  for (const message of forms.parseErrors) {
    report("parse-error", { line: 1, column: 0 }, `could not be parsed, so its imports cannot be checked: ${message}`, "parse")
  }

  for (const site of forms.computed) {
    if (config.imports.computed === "error" || (config.imports.computed === "error-in-shipped" && shipped)) {
      report("computed-import", site, `${site.text}: ${site.reason}; nothing can check what it loads`, site.text)
    }
  }

  /**
   * The packages that hold a runtime's own types, by the runtime module they describe: a type-only use of one
   * (`/// <reference types="node" />`, `import type {} from "bun-types"`) is a use of that runtime, judged by
   * `runtime-module` like `node:fs` and never as an outside package to declare.
   */
  const runtimeOf = (site: { readonly specifier: string; readonly typeOnly: boolean }): string | undefined => {
    const modules = site.typeOnly ? runtimeTypePackages[packageNameOf(site.specifier)] : undefined

    return modules?.find((module) => isRuntimeModule(config, module))
  }

  for (const site of forms.imports) {
    // Whether the rules that care about loading skip this import; kind edges below see the real form.
    const typeOnly = site.typeOnly && config.imports.typeOnly === "relaxed"
    const specifier = withoutQuery(site.specifier)
    const runtime = runtimeOf(site)
    const target: Target = runtime === undefined ? engine.resolver.resolve(file, site.specifier) : { kind: "runtime", name: runtime }

    // Judged by what is written and by what it resolves to, so an alias (`#fc` for fast-check) hides nothing.
    // A subpath (`@acme/conformance/guarantee`) is judged as written; only an alias adds the package it stands for.
    const resolvedName = target.kind === "external" || target.kind === "workspace" ? target.name : undefined
    const subpathOf = (name: string) => specifier === name || specifier.startsWith(`${name}/`)
    const names = resolvedName === undefined || subpathOf(resolvedName) ? [specifier] : [specifier, resolvedName]

    if (shipped && names.some((name) => matchesAny(name, config.testOnlySpecifiers))) {
      report("test-only-in-shipped", site, `shipped code imports the test-only ${specifier}`, specifier)
    }

    /** Shipped code imports a development file: judge it now, or hand it to the walk that is judging this file. */
    const judgeDevelopmentImport = (developmentFile: string, described: string) => {
      if (developmentImports !== undefined) {
        developmentImports.push(developmentFile)

        return
      }

      const breaks = developmentFileBreaks(engine, developmentFile)

      if (breaks !== undefined) {
        report("shipped-imports-development-file", site, `shipped code imports ${described} which would not pass as shipped code: ${breaks}`, specifier)
      }
    }

    switch (target.kind) {
      case "runtime": {
        if (shipped && !typeOnly && kindRule?.runtimeModules === false) {
          const what = runtime === undefined ? `the runtime module ${specifier},` : `the runtime types package ${specifier},`
          report("runtime-module", site, `imports ${what} which ${article(kind)} package may not use in shipped code`, specifier)
        }

        break
      }

      case "virtual": {
        break
      }

      case "unknown-workspace": {
        report("unknown-workspace-package", site, `${target.name} is not a workspace package`, target.name)
        break
      }

      case "dotted": {
        report("package-path-escape", site, `${specifier} walks out of ${target.name} with . or ..; import the package you mean by its name`, specifier)
        break
      }

      case "workspace": {
        const to = workspace.byName.get(target.name)

        if (to === undefined) {
          break
        }

        // An exported subpath may point at a development file of that package (`@acme/quota/conformance`), its own included.
        const toRelative = target.file?.slice(to.directory.length + 1)

        if (
          shipped &&
          !typeOnly &&
          target.file !== undefined &&
          toRelative !== undefined &&
          (!reads(engine, target.file) || effectivePolicy(engine, to, toRelative) !== "shipped")
        ) {
          judgeDevelopmentImport(
            target.file,
            `${specifier}, ${reads(engine, target.file) ? "a development file" : "a file the check does not otherwise read"} of ${to.name} (${target.file}),`,
          )
        }

        if (to.name === owner.name) {
          if (config.imports.selfByName === "error") {
            report("self-import-by-name", site, "imports its own package by its name; use a relative path", specifier)
          }

          break
        }

        const refusal = edgeRefusal(engine, owner, to, site.typeOnly, specifier)

        if (refusal !== undefined) {
          report(refusal.rule, site, refusal.why, to.name)
        }

        if (config.imports.requireDeclared && !declares(engine, owner, to.name, !shipped || typeOnly)) {
          report(
            "undeclared-import",
            site,
            `imports ${to.name}, which ${owner.directory}/package.json does not declare${shipped ? " for shipped code" : ""}`,
            to.name,
          )
        }

        break
      }

      case "file": {
        const to = packageOfFile(workspace, target.path)

        if (to?.name !== owner.name) {
          const where = to === undefined ? "a file outside every package" : `into ${to.name}`
          report("relative-import-leaves-package", site, `${specifier} reaches ${where}; import a package by its name`, specifier)
        } else if (shipped && !typeOnly && !reads(engine, target.path)) {
          judgeDevelopmentImport(target.path, `${specifier}, a file the check does not otherwise read (output or ignore),`)
        } else if (shipped && !typeOnly && effectivePolicy(engine, owner, target.path.slice(owner.directory.length + 1)) !== "shipped") {
          judgeDevelopmentImport(target.path, `${specifier}, a development file,`)
        }

        break
      }

      case "outside": {
        report("relative-import-leaves-package", site, `${specifier} reaches ${target.where}`, specifier)
        break
      }

      case "unresolved": {
        if (config.imports.unresolved === "error") {
          report("unresolved-import", site, `${specifier} names no file`, specifier)
        }

        break
      }

      case "external": {
        const allowed = kindRule?.externals
        const extra = refinements?.externals ?? []
        const permitted = (name: string) => allowed === "any" || allowed?.includes(name) === true || extra.includes(name)

        if (shipped && !typeOnly && !permitted(target.name)) {
          report("forbidden-external", site, `${article(kind)} package may not import ${target.name} in shipped code`, target.name)
        }

        const anywhere = !shipped || typeOnly
        const declared =
          declares(engine, owner, target.name, anywhere) ||
          declares(engine, owner, target.written, anywhere) ||
          (site.typeOnly && declares(engine, owner, typesPackage(target.name), anywhere))

        if (config.imports.requireDeclared && !declared) {
          report(
            "undeclared-import",
            site,
            `imports ${target.name}, which ${owner.directory}/package.json does not declare${shipped ? " for shipped code" : ""}`,
            target.name,
          )
        }

        break
      }
    }
  }

  return findings
}

/** Whether `entry` covers `finding`. */
export const baselineCovers = (entry: BaselineEntry, finding: Finding): boolean =>
  entry.file === finding.file && entry.rule === finding.rule && entry.target === finding.target

/** `findings` less those the baseline covers. */
export const withoutBaselined = (engine: Engine, findings: readonly Finding[]): Finding[] =>
  findings.filter((finding) => !engine.config.baseline.some((entry) => baselineCovers(entry, finding)))
