/**
 * One engine for both front ends: the oxlint rule calls `findingsForFile` per file for editor feedback, and the CLI calls
 * it over every file and adds the whole-graph checks (`graph.ts`), so the two never disagree. Rules adapted from the
 * module graph checks of phibkro/file-transfer, phibkro/vektorprogrammet-reimagined and reebeat/reebeat.
 */
import { resolveConfig } from "./config.ts"
import type { BaselineEntry, Config, FilePolicy, ResolvedConfig, RuleName } from "./config.ts"
import { matchesAny } from "./glob.ts"
import { makeResolver } from "./resolve.ts"
import type { Resolve } from "./resolve.ts"
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
}

export interface Engine {
  readonly workspace: Workspace
  readonly config: ResolvedConfig
  readonly resolve: Resolve
  /** The kind of a workspace package, or undefined when no kind's globs match its directory. */
  readonly kindOf: (entry: WorkspacePackage) => string | undefined
}

export const createEngine = (root: string, config: Config): Engine => {
  const resolved = resolveConfig(config)
  const workspace = loadWorkspace(root)
  const kinds = new Map<string, string | undefined>()

  for (const entry of workspace.packages) {
    kinds.set(entry.name, Object.entries(resolved.kinds).find(([, kind]) => matchesAny(entry.directory, kind.packages))?.[0])
  }

  return { workspace, config: resolved, resolve: makeResolver(workspace, resolved), kindOf: (entry) => kinds.get(entry.name) }
}

/** The policy of a package-relative file: the first file class that matches, else shipped. */
export const policyOf = (config: ResolvedConfig, packageRelative: string): FilePolicy =>
  config.fileClasses.find((fileClass) => matchesAny(packageRelative, fileClass.files))?.policy ?? "shipped"

const shippedFields = ["dependencies", "peerDependencies", "optionalDependencies"] as const

/** Whether `entry` declares `name` where the file's policy needs it. */
const declares = (workspace: Workspace, entry: WorkspacePackage, name: string, shipped: boolean): boolean => {
  if (shippedFields.some((field) => entry.manifest[field].includes(name))) {
    return true
  }

  return !shipped && (entry.manifest.devDependencies.includes(name) || Object.values(workspace.rootManifest).some((names) => names.includes(name)))
}

/** `@types/scope__name` for `@scope/name`, `@types/name` for `name`. */
const typesPackage = (name: string) => `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`

/** Why `from` (of kind `kind`) may not import workspace package `to`, or undefined when it may. */
export const edgeRefusal = (engine: Engine, from: WorkspacePackage, to: WorkspacePackage, typeOnly: boolean): { rule: RuleName; why: string } | undefined => {
  const kind = engine.kindOf(from)
  const targetKind = engine.kindOf(to)
  const refinements = engine.config.packages[from.name]

  if (kind === undefined || targetKind === undefined) {
    return undefined
  }

  if (refinements?.typeOnlyUses?.includes(to.name) === true) {
    return typeOnly ? undefined : { rule: "type-only-edge", why: `${from.name} may import ${to.name} only with type-only imports` }
  }

  const rule = engine.config.kinds[kind]

  if (rule !== undefined && rule.mayUse !== "any" && !rule.mayUse.includes(targetKind)) {
    return { rule: "forbidden-edge", why: `a ${kind} package may not import ${to.name}, a ${targetKind}` }
  }

  if (refinements?.uses !== undefined && !refinements.uses.includes(to.name)) {
    return { rule: "forbidden-edge", why: `${from.name} may import only ${refinements.uses.join(", ") || "no workspace package"}, not ${to.name}` }
  }

  return undefined
}

/** Every finding for one file, before the baseline. `file` is repository-relative and `text` is its source. */
export const findingsForFile = (engine: Engine, file: string, text: string): Finding[] => {
  const { config, workspace } = engine

  if (matchesAny(file, config.ignore)) {
    return []
  }

  const owner = packageOfFile(workspace, file)

  if (owner === undefined) {
    return []
  }

  const packageRelative = file.slice(owner.directory.length + 1)
  const policy = policyOf(config, packageRelative)

  if (policy === "unchecked") {
    return []
  }

  const findings: Finding[] = []
  const kind = engine.kindOf(owner)

  const report = (rule: RuleName, place: { line: number; column: number }, message: string, target?: string) => {
    findings.push(target === undefined ? { rule, file, ...place, message } : { rule, file, ...place, message, target })
  }

  if (kind === undefined) {
    report("package-without-kind", { line: 1, column: 0 }, `${owner.name} (${owner.directory}) matches no kind: add its directory to one`, owner.name)

    return findings
  }

  const kindRule = config.kinds[kind]
  const refinements = config.packages[owner.name]
  // A test-support file ships as a source of tests (a conformance suite's entry): it is checked as a development file.
  const shipped = policy === "shipped" && !matchesAny(packageRelative, refinements?.testSupportFiles ?? [])
  const forms = importForms(file, text)

  for (const message of forms.parseErrors) {
    report("parse-error", { line: 1, column: 0 }, `could not be parsed, so its imports cannot be checked: ${message}`)
  }

  for (const site of forms.computed) {
    if (config.imports.computed === "error" || (config.imports.computed === "error-in-shipped" && shipped)) {
      report("computed-import", site, `${site.text}: ${site.reason}; nothing can check what it loads`, site.text)
    }
  }

  for (const site of forms.imports) {
    const { specifier, typeOnly } = site
    const target = engine.resolve(file, specifier)

    if (shipped && matchesAny(specifier, config.testOnlySpecifiers)) {
      report("test-only-in-shipped", site, `shipped code imports the test-only ${specifier}`, specifier)
    }

    switch (target.kind) {
      case "runtime": {
        if (shipped && kindRule?.runtimeModules === false) {
          report("runtime-module", site, `imports the runtime module ${specifier}, which a ${kind} package may not use in shipped code`, specifier)
        }

        break
      }

      case "unknown-workspace": {
        report("unknown-workspace-package", site, `${target.name} is not a workspace package`, target.name)
        break
      }

      case "workspace": {
        const to = workspace.byName.get(target.name)

        if (to === undefined) {
          break
        }

        if (to.name === owner.name) {
          if (config.imports.selfByName === "error") {
            report("self-import-by-name", site, `imports its own package by its name; use a relative path`, specifier)
          }

          break
        }

        const refusal = edgeRefusal(engine, owner, to, typeOnly)

        if (refusal !== undefined) {
          report(refusal.rule, site, refusal.why, to.name)
        }

        if (config.imports.requireDeclared && !declares(workspace, owner, to.name, shipped)) {
          report(
            "undeclared-import",
            site,
            `imports ${to.name}, which ${owner.directory}/package.json does not declare${shipped ? " in dependencies" : ""}`,
            to.name,
          )
        }

        break
      }

      case "file": {
        const to = packageOfFile(workspace, target.path)

        if (to?.name !== owner.name) {
          const where = to === undefined ? "outside every package" : `into ${to.name}`
          report("relative-import-leaves-package", site, `${specifier} reaches ${where}; import a package by its name`, specifier)
        }

        break
      }

      case "outside": {
        report("relative-import-leaves-package", site, `${specifier} reaches outside the repository`, specifier)
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

        if (shipped && allowed !== undefined && allowed !== "any" && !allowed.includes(target.name) && !extra.includes(target.name)) {
          report("forbidden-external", site, `a ${kind} package may not import ${target.name} in shipped code`, target.name)
        }

        const declared = declares(workspace, owner, target.name, shipped) || (typeOnly && declares(workspace, owner, typesPackage(target.name), shipped))

        if (config.imports.requireDeclared && !declared) {
          report(
            "undeclared-import",
            site,
            `imports ${target.name}, which ${owner.directory}/package.json does not declare${shipped ? " in dependencies" : ""}`,
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
  entry.file === finding.file && entry.rule === finding.rule && (entry.target === undefined || entry.target === finding.target)

/** `findings` less those the baseline covers. */
export const withoutBaselined = (engine: Engine, findings: readonly Finding[]): Finding[] =>
  findings.filter((finding) => !engine.config.baseline.some((entry) => baselineCovers(entry, finding)))
