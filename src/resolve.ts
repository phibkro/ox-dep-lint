/**
 * What a specifier names, resolved the way TypeScript and bundlers do with oxc-resolver (Oxlint's own resolver):
 * `tsconfig.json` `paths`, `package.json` `imports` and `exports`, `.js` for the `.ts` beside it, symbolic links followed.
 * Adapted from `resolveImports.ts` of phibkro/vektorprogrammet-reimagined (same author).
 */
import { realpathSync } from "node:fs"
import nodePath from "node:path"
import { ResolverFactory } from "oxc-resolver"
import type { ResolvedConfig } from "./config.ts"
import { packageNameOf } from "./workspace.ts"
import type { Workspace } from "./workspace.ts"

export type Target =
  /** A runtime module: `node:fs`, `fs`, `bun`, `cloudflare:workers`. */
  | { readonly kind: "runtime"; readonly name: string }
  /** A workspace package by its name. */
  | { readonly kind: "workspace"; readonly name: string }
  /** A name under a workspace scope that no package has. */
  | { readonly kind: "unknown-workspace"; readonly name: string }
  /** A file of the repository, by a relative path or an alias; repository-relative. */
  | { readonly kind: "file"; readonly path: string }
  /** A relative path that reaches a file outside the repository (absolute path). */
  | { readonly kind: "outside"; readonly path: string }
  /** A relative path or alias that names no file of the repository. */
  | { readonly kind: "unresolved" }
  /** An installed package. */
  | { readonly kind: "external"; readonly name: string }

export type Resolve = (importer: string, specifier: string) => Target

const aliasPrefixes = ["#", "@/", "~/"]

const isRelative = (specifier: string) => specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")

export const isRuntimeModule = (config: ResolvedConfig, specifier: string): boolean =>
  config.runtimePrefixes.some((prefix) => specifier.startsWith(prefix)) || config.runtimeNames.has(packageNameOf(specifier))

/** A resolver for files of `workspace`; `importer` is repository-relative. */
export const makeResolver = (workspace: Workspace, config: ResolvedConfig): Resolve => {
  const factory = new ResolverFactory({
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

  const inside = (absolute: string): string | undefined =>
    absolute.startsWith(`${realRoot}${nodePath.sep}`) && !absolute.split(nodePath.sep).includes("node_modules")
      ? absolute
          .slice(realRoot.length + 1)
          .split(nodePath.sep)
          .join("/")
      : undefined

  return (importer, written) => {
    const specifier = written.replace(/\?.*$/u, "")

    if (isRuntimeModule(config, specifier)) {
      return { kind: "runtime", name: specifier }
    }

    const name = packageNameOf(specifier)

    if (!isRelative(specifier)) {
      if (workspace.byName.has(name)) {
        return { kind: "workspace", name }
      }

      if (config.workspaceScopes.some((scope) => specifier.startsWith(scope))) {
        return { kind: "unknown-workspace", name }
      }
    }

    const { path } = factory.resolveFileSync(nodePath.join(realRoot, importer), specifier)
    const file = path === undefined ? undefined : inside(path)

    if (file !== undefined) {
      return { kind: "file", path: file }
    }

    if (isRelative(specifier)) {
      // A relative path that reaches a file outside the repository leaves every package; one that names nothing is unresolved.
      return path === undefined ? { kind: "unresolved" } : { kind: "outside", path }
    }

    // An alias (`#x`, `@/x`, `~/x`) that names no file fails closed rather than passing as a package.
    if (path === undefined && aliasPrefixes.some((prefix) => specifier.startsWith(prefix))) {
      return { kind: "unresolved" }
    }

    return { kind: "external", name }
  }
}
