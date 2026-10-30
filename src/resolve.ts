/**
 * What a specifier names, resolved the way TypeScript and bundlers do with oxc-resolver (Oxlint's own resolver):
 * `tsconfig.json` `paths`, `package.json` `imports` and `exports`, `.js` for the `.ts` beside it, symbolic links followed.
 * Adapted from `resolveImports.ts` of phibkro/vektorprogrammet-reimagined (same author).
 *
 * An outside package is named by where it resolves (the last `node_modules` segment of its path), not by how it is
 * written, so an alias (`paths`, `#imports`, `npm:`) cannot pass one package off as another.
 */
import { existsSync, realpathSync } from "node:fs"
import nodePath from "node:path"
import { ResolverFactory } from "oxc-resolver"
import type { ResolvedConfig } from "./config.ts"
import { packageNameOf, packageOfFile } from "./workspace.ts"
import type { Workspace } from "./workspace.ts"

export type Target =
  /** A runtime module: `node:fs`, `fs`, `bun`, `cloudflare:workers`. */
  | { readonly kind: "runtime"; readonly name: string }
  /** A bundler's virtual module (`virtual:pwa-register`): nothing on disk to check. */
  | { readonly kind: "virtual" }
  /** A workspace package: the one the import resolves into (a `paths` alias may spell another), and the file when found. */
  | { readonly kind: "workspace"; readonly name: string; readonly file?: string }
  /** A name under a workspace scope that no package has. */
  | { readonly kind: "unknown-workspace"; readonly name: string }
  /** A package specifier with `.` or `..` segments after the name (`@acme/a/../b/src/x.ts`). */
  | { readonly kind: "dotted"; readonly name: string }
  /** A file of the repository, by a relative path or an alias; repository-relative. */
  | { readonly kind: "file"; readonly path: string }
  /** A relative path that reaches a file outside the repository, or into a `node_modules` directory. */
  | { readonly kind: "outside"; readonly where: string }
  /** A relative path or alias that names no file of the repository. */
  | { readonly kind: "unresolved" }
  /** An installed package: `name` is where it resolves, `written` how the import names it. */
  | { readonly kind: "external"; readonly name: string; readonly written: string }

export interface Resolver {
  readonly resolve: (importer: string, specifier: string) => Target
  /** Forgets what the file system looked like (an editor session after files were added). */
  readonly clear: () => void
}

const aliasPrefixes = ["#", "@/", "~/"]

const isRelative = (specifier: string) => specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")

export const isRuntimeModule = (config: ResolvedConfig, specifier: string): boolean =>
  config.runtimePrefixes.some((prefix) => specifier.startsWith(prefix)) || config.runtimeNames.has(packageNameOf(specifier))

/** The package a path inside `node_modules` belongs to: the name after its last `node_modules` segment. */
const installedName = (path: string): string | undefined => {
  const parts = path.split(nodePath.sep)
  const index = parts.lastIndexOf("node_modules")

  if (index === -1) {
    return undefined
  }

  const first = parts[index + 1]

  return first?.startsWith("@") === true ? `${first}/${parts[index + 2] ?? ""}` : first
}

/** Strips a query (`?raw`) and a fragment, never a leading `#` (a package import). */
export const withoutQuery = (specifier: string): string => specifier.charAt(0) + specifier.slice(1).replace(/[?#].*$/u, "")

export const makeResolver = (workspace: Workspace, config: ResolvedConfig): Resolver => {
  const factory = new ResolverFactory({
    builtinModules: true,
    conditionNames: ["import", "types", "node", "default"],
    extensionAlias: {
      ".cjs": [".cts", ".d.cts", ".cjs"],
      ".js": [".ts", ".tsx", ".d.ts", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".d.mts", ".mjs"],
    },
    extensions: [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    symlinks: true,
    tsconfig: "auto",
  })
  const realRoot = realpathSync(workspace.root)

  const inside = (absolute: string): string | undefined => {
    if (!absolute.startsWith(`${realRoot}${nodePath.sep}`)) {
      return undefined
    }

    const relative = absolute.slice(realRoot.length + 1).split(nodePath.sep)

    return relative.includes("node_modules") ? undefined : relative.join("/")
  }

  const resolveFile = (importer: string, specifier: string) => {
    const first = factory.resolveFileSync(nodePath.join(realRoot, importer), specifier)

    // A cached path to a file deleted since (an editor session) does not count as found.
    if (first.builtin !== undefined || (first.path !== undefined && existsSync(first.path))) {
      return first
    }

    // The resolver caches the file system; a file added since (an editor session) deserves one fresh look.
    factory.clearCache()

    return factory.resolveFileSync(nodePath.join(realRoot, importer), specifier)
  }

  const resolve = (importer: string, written: string): Target => {
    const specifier = withoutQuery(written)

    if (isRuntimeModule(config, specifier)) {
      return { kind: "runtime", name: specifier }
    }

    if (config.virtualPrefixes.some((prefix) => specifier.startsWith(prefix))) {
      return { kind: "virtual" }
    }

    const name = packageNameOf(specifier)

    if (!isRelative(specifier) && !specifier.startsWith("/")) {
      const subpath = specifier.slice(name.length).split("/")

      if (
        (workspace.byName.has(name) || config.workspaceScopes.some((scope) => specifier.startsWith(scope))) &&
        subpath.some((part) => part === "." || part === "..")
      ) {
        return { kind: "dotted", name }
      }

      if (workspace.byName.has(name)) {
        // Resolved too: a `paths` alias may send a workspace name somewhere else, and the file decides the edge.
        const found = resolveFile(importer, specifier).path
        const file = found === undefined ? undefined : inside(found)
        const owner = file === undefined ? undefined : packageOfFile(workspace, file)

        return file === undefined ? { kind: "workspace", name } : { kind: "workspace", name: owner?.name ?? name, file }
      }

      if (config.workspaceScopes.some((scope) => specifier.startsWith(scope))) {
        return { kind: "unknown-workspace", name }
      }
    }

    // A root-absolute path (`/src/x.ts`) is Vite's: relative to the importing package's directory.
    const request = specifier.startsWith("/") ? nodePath.join(realRoot, packageOfFile(workspace, importer)?.directory ?? "", specifier) : specifier
    const result = resolveFile(importer, request)

    if (result.builtin !== undefined) {
      return { kind: "runtime", name: result.builtin.resolved }
    }

    const file = result.path === undefined ? undefined : inside(result.path)

    if (file !== undefined) {
      return { kind: "file", path: file }
    }

    if (isRelative(specifier) || specifier.startsWith("/")) {
      if (result.path === undefined) {
        return existsSync(request) && specifier.startsWith("/") ? { kind: "file", path: nodePath.relative(realRoot, request) } : { kind: "unresolved" }
      }

      return { kind: "outside", where: result.path.startsWith(`${realRoot}${nodePath.sep}`) ? "into a node_modules directory" : "outside the repository" }
    }

    if (result.path === undefined) {
      // An alias that names no file fails closed rather than passing as a package.
      return aliasPrefixes.some((prefix) => specifier.startsWith(prefix)) ? { kind: "unresolved" } : { kind: "external", name, written: name }
    }

    // An `npm:` alias keeps the name it is declared under, which is what a configuration names.
    const importerPackage = packageOfFile(workspace, importer)
    const aliased = importerPackage?.aliases.has(name) === true || workspace.rootAliases.has(name)

    return { kind: "external", name: aliased ? name : (installedName(result.path) ?? name), written: name }
  }

  return { resolve, clear: () => factory.clearCache() }
}
