/** Negative controls for the bypasses and false positives the independent review of 0.1.0 found, one per finding. */
import { describe, expect, it } from "vite-plus/test"
import type { Config } from "../src/config.ts"
import { configProblems } from "../src/config.ts"
import { findingsWith, validConfig, validWorkspace } from "./support/workspace.ts"

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
  it("rejects shipped code importing a test or a script of its own package", () => {
    expect(
      findingsWith({
        [library]: 'export * from "./plant.test.ts"\nexport * from "../scripts/helpers.ts"\n',
        "libraries/parcel/src/plant.test.ts": "export const x = 1\n",
        "libraries/parcel/scripts/helpers.ts": "export const y = 1\n",
      }),
    ).toEqual(["shipped-imports-development-file ../scripts/helpers.ts", "shipped-imports-development-file ./plant.test.ts"])
  })

  it("allows a type-only import of a development file", () => {
    expect(findingsWith({ [library]: 'export type { X } from "./plant.test.ts"\n', "libraries/parcel/src/plant.test.ts": "export type X = 1\n" })).toEqual([])
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
