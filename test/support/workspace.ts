/** Builds a throwaway workspace on disk from a map of repository-relative paths to contents. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import type { Config } from "../../src/config.ts"
import { checkWorkspace } from "../../src/check.ts"

export type Files = Readonly<Record<string, string | object>>

export const writeWorkspace = (files: Files): string => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "ox-dep-lint-"))
  writeWorkspaceFiles(root, files)

  return root
}

/** Writes `files` into the existing workspace at `root`. */
export const writeWorkspaceFiles = (root: string, files: Files) => {
  for (const [path, contents] of Object.entries(files)) {
    const absolute = nodePath.join(root, path)
    mkdirSync(nodePath.dirname(absolute), { recursive: true })
    writeFileSync(absolute, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`)
  }
}

export const removeWorkspace = (root: string) => {
  rmSync(root, { recursive: true, force: true })
}

const manifest = (name: string, fields: Record<string, readonly string[]> = {}) => ({
  name,
  type: "module",
  ...Object.fromEntries(
    Object.entries(fields).map(([field, names]) => [
      field,
      Object.fromEntries(names.map((entry) => [entry, entry.startsWith("@acme/") ? "workspace:*" : "1.0.0"])),
    ]),
  ),
})

/**
 * A small valid workspace in the shape of file-transfer's: a library, a service, a platform, an app and a tool, with a
 * root devDependency. Each negative control changes one file of it.
 */
export const validWorkspace: Files = {
  "package.json": {
    name: "acme",
    private: true,
    workspaces: ["libraries/*", "services/*", "platforms/*", "apps/*", "tools/*"],
    devDependencies: { "fast-check": "1.0.0" },
  },
  "libraries/parcel/package.json": manifest("@acme/parcel", { dependencies: ["effect"] }),
  "libraries/parcel/src/index.ts": 'import { Effect } from "effect"\nimport { size } from "./size.ts"\nexport const parcel = () => Effect.succeed(size)\n',
  "libraries/parcel/src/size.ts": "export const size = 1\n",
  "libraries/parcel/test/parcel.test.ts": 'import fc from "fast-check"\nimport { parcel } from "../src/index.ts"\nexport const property = [fc, parcel]\n',
  "libraries/conformance/package.json": manifest("@acme/conformance", { dependencies: ["fast-check"] }),
  "libraries/conformance/src/index.ts": 'import fc from "fast-check"\nexport const suite = fc\n',
  "services/room/package.json": manifest("@acme/service-room", { dependencies: ["@acme/parcel", "effect"], devDependencies: ["@acme/conformance"] }),
  "services/room/src/index.ts":
    'import { parcel } from "@acme/parcel"\nimport type { Effect } from "effect"\nexport type Room = Effect.Effect<number>\nexport const room = parcel\n',
  "services/room/test/conformance.ts": 'import { suite } from "@acme/conformance"\nexport const conformance = suite\n',
  "services/quota/package.json": manifest("@acme/service-quota", { dependencies: ["@acme/parcel"] }),
  "services/quota/src/index.ts": 'export * from "@acme/parcel"\n',
  "platforms/cloudflare/package.json": manifest("@acme/platform-cloudflare", {
    dependencies: ["@acme/service-room", "@acme/service-quota"],
    devDependencies: ["wrangler"],
  }),
  "platforms/cloudflare/src/worker.ts":
    'import { DurableObject } from "cloudflare:workers"\nimport { createHash } from "node:crypto"\nimport { room } from "@acme/service-room"\nimport "@acme/service-quota"\nexport const worker = [DurableObject, createHash, room]\n',
  "platforms/cloudflare/scripts/deploy.ts":
    'import wrangler from "wrangler"\nconst name = "./config.ts"\nexport const config = await import(name)\nexport const tool = wrangler\n',
  "apps/web/package.json": manifest("@acme/web", { dependencies: ["@acme/parcel"] }),
  "apps/web/src/main.ts": 'import { parcel } from "@acme/parcel"\nexport const main = await import(`./lazy.ts`)\nexport const run = parcel\n',
  "apps/web/src/lazy.ts": "export const lazy = 1\n",
  "tools/quality/package.json": manifest("@acme/tool-quality", { dependencies: ["@acme/web", "@acme/platform-cloudflare"] }),
  "tools/quality/src/check.ts":
    'import { readFileSync } from "node:fs"\nimport "@acme/web"\nimport "@acme/platform-cloudflare"\nexport const read = readFileSync\n',
}

export const validConfig: Config = {
  workspaceScopes: ["@acme/"],
  kinds: {
    library: { packages: ["libraries/*"], mayUse: ["library"], externals: ["effect", "fast-check"], runtimeModules: false },
    service: { packages: ["services/*"], mayUse: ["library"], externals: ["effect"], runtimeModules: false },
    platform: { packages: ["platforms/*"], mayUse: ["library", "service"] },
    app: { packages: ["apps/*"], mayUse: ["library"] },
    tool: { packages: ["tools/*"], mayUse: "any" },
  },
  packages: { "@acme/conformance": { testSupportFiles: ["src/index.ts"] } },
  testOnlySpecifiers: ["fast-check", "@acme/conformance"],
}

/** The `rule target` pairs of a check of `validWorkspace` with `changes` applied, sorted. */
export const findingsWith = (changes: Files, config: Config = validConfig): string[] => {
  const root = writeWorkspace({ ...validWorkspace, ...changes })

  try {
    return checkWorkspace(root, config)
      .findings.map((finding) => `${finding.rule} ${finding.target ?? ""}`.trim())
      .toSorted()
  } finally {
    removeWorkspace(root)
  }
}
