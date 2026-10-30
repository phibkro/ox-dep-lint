/** Negative controls for the bypasses and false positives the independent review of 0.1.0 found, one per finding. */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import nodePath from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { checkWorkspace } from "../src/check.ts"
import type { Config } from "../src/config.ts"
import { configProblems } from "../src/config.ts"
import { findWorkspaceRoot } from "../src/workspace.ts"
import { findingsWith, removeWorkspace, validConfig, validWorkspace, writeWorkspace } from "./support/workspace.ts"

const library = "libraries/parcel/src/plant.ts"

describe("loaders other than import (review finding 1)", () => {
  it("reads require, require.resolve, import.meta.require, process.getBuiltinModule and an applied createRequire", () => {
    const source = [
      'const fs = require("node:fs")',
      'const path = require.resolve("fs")',
      'const cloud = import.meta.require("@acme/platform-cloudflare")',
      'const os = process.getBuiltinModule("node:os")',
      'import { createRequire } from "node:module"',
      'const crypto = createRequire(import.meta.url)("node:crypto")',
      "export const all = [fs, path, cloud, os, crypto]",
    ].join("\n")

    expect(findingsWith({ [library]: source })).toEqual([
      "forbidden-edge @acme/platform-cloudflare",
      "runtime-module fs",
      "runtime-module node:crypto",
      "runtime-module node:fs",
      "runtime-module node:module",
      "runtime-module node:os",
      "undeclared-import @acme/platform-cloudflare",
    ])
  })

  it("reads require in a CommonJS file", () => {
    expect(findingsWith({ "libraries/parcel/src/legacy.cjs": 'module.exports = require("@acme/platform-cloudflare")\n' })).toContain(
      "forbidden-edge @acme/platform-cloudflare",
    )
  })

  it("reports a require function made by createRequire and kept, which the check cannot follow", () => {
    const source = 'import { createRequire } from "node:module"\nconst load = createRequire(import.meta.url)\nexport const x = load("anything")\n'
    expect(findingsWith({ "platforms/cloudflare/src/load.ts": source })).toEqual(["computed-import createRequire(import.meta.url)"])
  })
})

describe("development files keep their edge checks (review finding 2)", () => {
  it("checks an escaped specifier in a test by the module it spells", () => {
    const escaped = ['import "@acme/platform-cl', "\\", 'x6fudflare"\n'].join("")
    expect(findingsWith({ "libraries/parcel/test/escape.test.ts": escaped })).toEqual([
      "forbidden-edge @acme/platform-cloudflare",
      "undeclared-import @acme/platform-cloudflare",
    ])
  })
})

describe("laundering through development files (review finding 3)", () => {
  it("rejects shipped code importing a development file that would not pass as shipped code", () => {
    const files = {
      [library]: 'export * from "./plant.test.ts"\nexport * from "../scripts/helpers.ts"\n',
      "libraries/parcel/src/plant.test.ts": 'import fc from "fast-check"\nexport const x = fc\n',
      "libraries/parcel/scripts/helpers.ts": 'export * from "./deeper.ts"\n',
      "libraries/parcel/scripts/deeper.ts": 'export { readFileSync } from "node:fs"\n',
    }
    expect(findingsWith(files)).toEqual(["shipped-imports-development-file ../scripts/helpers.ts", "shipped-imports-development-file ./plant.test.ts"])
  })

  it("allows a development file that would pass as shipped code, and any type-only import", () => {
    expect(findingsWith({ [library]: 'export * from "../scripts/shared.ts"\n', "libraries/parcel/scripts/shared.ts": "export const shared = 1\n" })).toEqual([])
    expect(
      findingsWith({ [library]: 'export type { X } from "./plant.test.ts"\n', "libraries/parcel/src/plant.test.ts": 'import "node:fs"\nexport type X = 1\n' }),
    ).toEqual([])
  })
})

describe("packages the workspace leaves out (review finding 4)", () => {
  it("reports a directory a kind names, with a package.json, outside the workspaces", () => {
    const root = { ...(validWorkspace["package.json"] as object), workspaces: ["libraries/*", "services/*", "platforms/*", "apps/*", "tools/*", "!apps/web"] }
    expect(
      findingsWith({
        "package.json": root,
        "tools/quality/package.json": { name: "@acme/tool-quality", dependencies: { "@acme/platform-cloudflare": "workspace:*" } },
        "tools/quality/src/check.ts": 'import "@acme/platform-cloudflare"\n',
      }),
    ).toEqual(["package-outside-workspace apps/web"])
  })
})

describe("package.json against the kind's externals (review finding 5)", () => {
  it("rejects a dependency the kind does not allow even when only a test imports it", () => {
    const manifest = { "libraries/parcel/package.json": { name: "@acme/parcel", dependencies: { effect: "1", zod: "1" } } }
    expect(findingsWith({ ...manifest, "libraries/parcel/test/zod.test.ts": 'import "zod"\n' })).toEqual(["forbidden-external zod"])
  })
})

describe("inline type modifiers still load the module (review finding 6)", () => {
  it("counts import { type X } and export { type X } from as value edges", () => {
    const config: Config = { ...validConfig, packages: { ...validConfig.packages, "@acme/web": { typeOnlyUses: ["@acme/service-room"] } } }
    const manifest = { "apps/web/package.json": { name: "@acme/web", dependencies: { "@acme/parcel": "workspace:*", "@acme/service-room": "workspace:*" } } }
    expect(findingsWith({ ...manifest, "apps/web/src/types.ts": 'import { type Room } from "@acme/service-room"\nexport type R = Room\n' }, config)).toEqual([
      "type-only-edge @acme/service-room",
    ])
    expect(findingsWith({ ...manifest, "apps/web/src/types.ts": 'export { type Room } from "@acme/service-room"\n' }, config)).toEqual([
      "type-only-edge @acme/service-room",
    ])
  })

  it("lets listed specifiers of a type-only package be values", () => {
    const config: Config = {
      ...validConfig,
      packages: { ...validConfig.packages, "@acme/web": { typeOnlyUses: ["@acme/service-room"], valueSpecifiers: ["@acme/service-room/steps"] } },
    }
    const manifest = { "apps/web/package.json": { name: "@acme/web", dependencies: { "@acme/parcel": "workspace:*", "@acme/service-room": "workspace:*" } } }
    expect(
      findingsWith({ ...manifest, "apps/web/src/steps.ts": 'import { steps } from "@acme/service-room/steps"\nexport const s = steps\n' }, config),
    ).toEqual([])
  })
})

describe("queries and dotted package paths (review findings 7 and 8)", () => {
  it("strips a query before matching test-only specifiers", () => {
    expect(findingsWith({ "apps/web/src/query.ts": 'import "fast-check?inline"\n' })).toContain("test-only-in-shipped fast-check")
  })

  it("rejects . and .. after a package name", () => {
    expect(findingsWith({ "apps/web/src/dotted.ts": 'import "@acme/parcel/../../platforms/cloudflare/src/worker.ts"\n' })).toEqual([
      "package-path-escape @acme/parcel/../../platforms/cloudflare/src/worker.ts",
    ])
  })
})

describe("workers and assets (review finding 9)", () => {
  it("reads new URL(..., import.meta.url) as an import", () => {
    const source = 'export const worker = new Worker(new URL("../../../services/room/src/index.ts", import.meta.url))\n'
    expect(findingsWith({ "apps/web/src/worker.ts": source })).toEqual(["relative-import-leaves-package ../../../services/room/src/index.ts"])
  })
})

describe("false positives (review finding 12)", () => {
  it("lets shipped code import types from a devDependency", () => {
    const manifest = {
      "platforms/cloudflare/package.json": {
        name: "@acme/platform-cloudflare",
        dependencies: { "@acme/service-room": "workspace:*", "@acme/service-quota": "workspace:*" },
        devDependencies: { wrangler: "1", "@cloudflare/workers-types": "1" },
      },
    }
    expect(
      findingsWith({
        ...manifest,
        "platforms/cloudflare/src/types.ts": 'import type { DurableObjectState } from "@cloudflare/workers-types"\nexport type S = DurableObjectState\n',
      }),
    ).toEqual([])
  })

  it("passes a bundler's virtual module", () => {
    expect(findingsWith({ "apps/web/src/pwa.ts": 'import { registerSW } from "virtual:pwa-register"\nexport const r = registerSW\n' })).toEqual([])
  })
})

describe("workspace and configuration robustness (review findings 10, 16 and 18)", () => {
  it("reports a member without a name and two members with one name instead of failing", () => {
    expect(findingsWith({ "tools/nameless/package.json": { private: true }, "tools/twin/package.json": { name: "@acme/web" } })).toEqual([
      "invalid-package tools/nameless",
      "invalid-package tools/twin",
    ])
  })

  it("ignores a dependencies field written as a list", () => {
    expect(
      findingsWith({ "apps/web/package.json": { name: "@acme/web", dependencies: { "@acme/parcel": "workspace:*" }, devDependencies: ["oops"] } }),
    ).toEqual([])
  })

  it("refuses misspelled keys and policies, and a baseline entry without a target", () => {
    const misspelled = {
      ...validConfig,
      kinds: { ...validConfig.kinds, library: { packages: ["libraries/*"], mayUse: ["library"], runtimeModule: false } },
      imports: { computed: "warn" },
    }
    // SAFETY: deliberately not a Config, to see what validation says about it.
    const problems = configProblems(misspelled as unknown as Config)
    expect(problems.join("\n")).toContain("kind library has the unknown key runtimeModule")
    expect(problems.join("\n")).toContain('imports.computed is "warn"')
    // SAFETY: as above.
    expect(
      configProblems({ ...validConfig, baseline: [{ file: library, rule: "forbidden-edge", reason: "later" }] } as unknown as Config).join("\n"),
    ).toContain("names no target")
  })
})

describe("the second review's findings", () => {
  it("roots a workspace nested inside another checkout at its own manifest (H1)", () => {
    const outer = writeWorkspace(validWorkspace)

    try {
      const inner = nodePath.join(outer, ".claude/worktrees/wt")
      mkdirSync(nodePath.join(inner), { recursive: true })
      writeFileSync(nodePath.join(inner, ".git"), "gitdir: elsewhere\n")
      expect(findWorkspaceRoot(nodePath.join(inner, "libraries/parcel/src"))).toBeUndefined()
      writeFileSync(nodePath.join(inner, "package.json"), JSON.stringify({ name: "wt", workspaces: ["libraries/*"] }))
      expect(findWorkspaceRoot(nodePath.join(inner, "libraries/parcel/src"))).toBe(inner)
      expect(findWorkspaceRoot(nodePath.join(outer, "libraries/parcel/src"))).toBe(outer)
    } finally {
      removeWorkspace(outer)
    }
  })

  it("does not let a member's empty workspaces make it a root", () => {
    const root = writeWorkspace({
      ...validWorkspace,
      "apps/web/package.json": { name: "@acme/web", workspaces: [], dependencies: { "@acme/parcel": "workspace:*" } },
    })

    try {
      expect(findWorkspaceRoot(nodePath.join(root, "apps/web/src"))).toBe(root)
    } finally {
      removeWorkspace(root)
    }
  })

  it("judges test-only specifiers by what an alias resolves to (H2)", () => {
    const root = writeWorkspace({
      ...validWorkspace,
      "apps/web/package.json": { name: "@acme/web", dependencies: { "@acme/parcel": "workspace:*", "fast-check": "1" }, imports: { "#fc": "fast-check" } },
      "apps/web/src/fuzz.ts": 'import fc from "#fc"\nexport const f = fc\n',
      "node_modules/fast-check/package.json": { name: "fast-check", main: "index.js" },
      "node_modules/fast-check/index.js": "export default 1\n",
    })

    try {
      expect(checkWorkspace(root, validConfig).findings.map((finding) => `${finding.rule} ${finding.target ?? ""}`)).toContain("test-only-in-shipped #fc")
    } finally {
      removeWorkspace(root)
    }
  })

  it("reads new URL only for source files, whatever query or fragment follows (M1, M2)", () => {
    const source = [
      'export const a = new URL("data.json", import.meta.url)',
      'export const b = new URL("../cms", import.meta.url)',
      'export const c = new URL("https://example.com/x.js", import.meta.url)',
      'export const d = new Worker(new URL("../../../services/room/src/index.ts#/", import.meta.url))',
    ].join("\n")
    expect(findingsWith({ "apps/web/src/urls.ts": source })).toEqual(["relative-import-leaves-package ../../../services/room/src/index.ts"])
  })

  it("does not treat a computed resolve as a load (M3), and catches require passed around (M5)", () => {
    expect(findingsWith({ "platforms/cloudflare/src/where.ts": "export const where = (entry: string) => import.meta.resolve(entry)\n" })).toEqual([])
    expect(findingsWith({ "platforms/cloudflare/src/load.ts": "const load = require\nexport const x = (0, require)\n" })).toEqual([
      "computed-import require",
      "computed-import require",
    ])
  })

  it("follows a workspace name a paths alias sends elsewhere (M7)", () => {
    const files = {
      "services/room/tsconfig.json": { compilerOptions: { paths: { "@acme/parcel": ["../../platforms/cloudflare/src/worker.ts"] } } },
      "services/room/src/index.ts": 'export * from "@acme/parcel"\n',
    }
    expect(findingsWith(files)).toContain("forbidden-edge @acme/platform-cloudflare")
  })

  it("refuses wrongly typed configuration values (L3)", () => {
    // SAFETY: deliberately not a Config, to see what validation says about it.
    const problems = configProblems({
      ...validConfig,
      testOnlySpecifiers: "fast-check",
      kinds: { ...validConfig.kinds, app: { packages: ["apps/*"] } },
    } as unknown as Config).join("\n")
    expect(problems).toContain("testOnlySpecifiers must be a list of strings")
    expect(problems).toContain('kind app: mayUse must be "any" or a list of kinds')
  })
})

describe("development files behind a package's exports (M6) and npm aliases (M8)", () => {
  it("rejects shipped code importing an exported subpath that is a development file using test-only modules", () => {
    const root = writeWorkspace({
      ...validWorkspace,
      "services/quota/package.json": {
        name: "@acme/service-quota",
        exports: { ".": "./src/index.ts", "./conformance": "./test/conformance.ts" },
        dependencies: { "@acme/parcel": "workspace:*" },
      },
      "services/quota/test/conformance.ts": 'import fc from "fast-check"\nexport const suite = fc\n',
      "platforms/cloudflare/src/suite.ts": 'export { suite } from "@acme/service-quota/conformance"\n',
    })

    try {
      mkdirSync(nodePath.join(root, "node_modules/@acme"), { recursive: true })
      symlinkSync(nodePath.join(root, "services/quota"), nodePath.join(root, "node_modules/@acme/service-quota"))
      expect(checkWorkspace(root, validConfig).findings.map((finding) => `${finding.rule} ${finding.target ?? ""}`)).toEqual([
        "shipped-imports-development-file @acme/service-quota/conformance",
      ])
    } finally {
      removeWorkspace(root)
    }
  })

  it("judges an npm alias by the name it is declared under, as bun's isolated store installs it", () => {
    const config: Config = { ...validConfig, kinds: { ...validConfig.kinds, app: { packages: ["apps/*"], mayUse: ["library"], externals: ["vite"] } } }
    const root = writeWorkspace({
      ...validWorkspace,
      "apps/web/package.json": { name: "@acme/web", dependencies: { "@acme/parcel": "workspace:*", vite: "npm:@voidzero-dev/vite-plus-core@1" } },
      "apps/web/src/build.ts": 'import { build } from "vite"\nexport const b = build\n',
      "node_modules/.bun/@voidzero-dev+vite-plus-core@1/node_modules/@voidzero-dev/vite-plus-core/package.json": {
        name: "@voidzero-dev/vite-plus-core",
        main: "index.js",
      },
      "node_modules/.bun/@voidzero-dev+vite-plus-core@1/node_modules/@voidzero-dev/vite-plus-core/index.js": "export const build = 1\n",
    })

    try {
      symlinkSync(
        nodePath.join(root, "node_modules/.bun/@voidzero-dev+vite-plus-core@1/node_modules/@voidzero-dev/vite-plus-core"),
        nodePath.join(root, "node_modules/vite"),
      )
      expect(checkWorkspace(root, config).findings).toEqual([])
    } finally {
      removeWorkspace(root)
    }
  })
})
