/**
 * One engine for both front ends: the oxlint rule calls `findingsForFile` per file for editor feedback, and the CLI calls
 * it over every file and adds the whole-graph checks (`graph.ts`), so the two never disagree. Rules adapted from the
 * module graph checks of phibkro/file-transfer, phibkro/vektorprogrammet-reimagined and reebeat/reebeat.
 */
import { readFileSync, statSync } from "node:fs"
import nodePath from "node:path"
import { resolveConfig } from "./config.ts"
import type { BaselineEntry, Config, FilePolicy, ManifestField, ResolvedConfig, RuleName } from "./config.ts"
import { matchesAny } from "./glob.ts"
import { makeResolver, withoutQuery } from "./resolve.ts"
import type { Resolver } from "./resolve.ts"
import { importForms } from "./specifiers.ts"
import { loadWorkspace, packageOfFile } from "./workspace.ts"
import type { Workspace, WorkspacePackage } from "./workspace.ts"

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
  const queue = [file]
  let breaks: string | undefined

  while (queue.length > 0 && breaks === undefined) {
    const next = queue.shift() ?? file
    const absolute = nodePath.join(engine.workspace.root, next)
    const time = modifiedTime(absolute)

    if (read.has(next) || time === undefined) {
      continue
    }

    read.set(next, time)
    const reached: string[] = []
    const finding = findingsForFile(engine, next, readFileSync(absolute, "utf8"), { developmentImports: reached }).find((candidate) =>
      shippedOnlyRules.has(candidate.rule),
    )

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

  if (owner === undefined || !reads(engine, file)) {
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

  for (const site of forms.imports) {
    const { typeOnly } = site
    const specifier = withoutQuery(site.specifier)
    const target = engine.resolver.resolve(file, site.specifier)

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
          report("runtime-module", site, `imports the runtime module ${specifier}, which ${article(kind)} package may not use in shipped code`, specifier)
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

        if (shipped && !typeOnly && target.file !== undefined && toRelative !== undefined && effectivePolicy(engine, to, toRelative) !== "shipped") {
          judgeDevelopmentImport(target.file, `${specifier}, a development file of ${to.name} (${target.file}),`)
        }

        if (to.name === owner.name) {
          if (config.imports.selfByName === "error") {
            report("self-import-by-name", site, "imports its own package by its name; use a relative path", specifier)
          }

          break
        }

        const refusal = edgeRefusal(engine, owner, to, typeOnly, specifier)

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
          (typeOnly && declares(engine, owner, typesPackage(target.name), true))

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
