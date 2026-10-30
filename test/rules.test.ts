import { describe, expect, it } from "vite-plus/test"
import type { Config } from "../src/config.ts"
import { findingsWith, validConfig } from "./support/workspace.ts"

const service = "services/room/src/index.ts"
const library = "libraries/parcel/src/index.ts"

describe("the valid workspace", () => {
  it("has no findings", () => {
    expect(findingsWith({})).toEqual([])
  })
})

describe("edges between packages", () => {
  it("rejects a forbidden kind edge written as an import", () => {
    expect(findingsWith({ [service]: 'import "@acme/platform-cloudflare"\n' })).toEqual([
      "forbidden-edge @acme/platform-cloudflare",
      "undeclared-import @acme/platform-cloudflare",
    ])
  })

  it("rejects the same edge as a re-export, an export star, a dynamic import and a type-level import", () => {
    for (const source of [
      'export { worker } from "@acme/platform-cloudflare"\n',
      'export * as cloud from "@acme/platform-cloudflare"\n',
      'export const cloud = await import("@acme/platform-cloudflare")\n',
      'export type Cloud = typeof import("@acme/platform-cloudflare")\n',
    ]) {
      expect(findingsWith({ [service]: source }), source).toContain("forbidden-edge @acme/platform-cloudflare")
    }
  })

  it("rejects an edge between two packages of one kind unless the kind lists itself", () => {
    expect(findingsWith({ [service]: 'import "@acme/service-quota"\n' })).toContain("forbidden-edge @acme/service-quota")
    // A library may use libraries.
    expect(findingsWith({ [library]: 'import "@acme/conformance"\n' })).not.toContain("forbidden-edge @acme/conformance")
  })

  it("checks kind edges in development files too", () => {
    expect(findingsWith({ "services/room/test/room.test.ts": 'import "@acme/platform-cloudflare"\n' })).toContain("forbidden-edge @acme/platform-cloudflare")
  })

  it("rejects a forbidden edge declared only in package.json, devDependencies included", () => {
    const declared = {
      "libraries/parcel/package.json": { name: "@acme/parcel", dependencies: { effect: "1" }, devDependencies: { "@acme/service-room": "workspace:*" } },
    }
    expect(findingsWith(declared)).toEqual(["forbidden-edge @acme/service-room"])
  })

  it("narrows a package to the packages it declares in its uses", () => {
    const config: Config = { ...validConfig, packages: { ...validConfig.packages, "@acme/platform-cloudflare": { uses: ["@acme/service-room"] } } }
    expect(findingsWith({}, config)).toEqual(["forbidden-edge @acme/service-quota", "forbidden-edge @acme/service-quota"])
  })

  it("allows a type-only use and rejects a value import of the same package", () => {
    const config: Config = { ...validConfig, packages: { ...validConfig.packages, "@acme/web": { typeOnlyUses: ["@acme/service-room"] } } }
    const manifest = { "apps/web/package.json": { name: "@acme/web", dependencies: { "@acme/parcel": "workspace:*", "@acme/service-room": "workspace:*" } } }
    expect(findingsWith({ ...manifest, "apps/web/src/types.ts": 'import type { Room } from "@acme/service-room"\nexport type R = Room\n' }, config)).toEqual([])
    expect(findingsWith({ ...manifest, "apps/web/src/types.ts": 'import { room } from "@acme/service-room"\nexport const r = room\n' }, config)).toEqual([
      "type-only-edge @acme/service-room",
    ])
  })

  it("rejects an unknown workspace package in an import and in package.json", () => {
    expect(findingsWith({ [service]: 'import "@acme/ghost"\n' })).toEqual(["unknown-workspace-package @acme/ghost"])
    const declared = {
      "services/room/package.json": {
        name: "@acme/service-room",
        dependencies: { "@acme/parcel": "workspace:*", effect: "1", "@acme/ghost": "1" },
        devDependencies: { "@acme/conformance": "workspace:*" },
      },
    }
    expect(findingsWith(declared)).toEqual(["unknown-workspace-package @acme/ghost"])
  })

  it("finds a cycle between packages", () => {
    const cycle = { "libraries/conformance/package.json": { name: "@acme/conformance", dependencies: { "fast-check": "1", "@acme/parcel": "workspace:*" } } }
    const back = { "libraries/parcel/package.json": { name: "@acme/parcel", dependencies: { effect: "1", "@acme/conformance": "workspace:*" } } }
    expect(findingsWith({ ...cycle, ...back })).toEqual(["package-cycle @acme/conformance @acme/parcel"])
  })

  it("reports a package no kind holds", () => {
    expect(
      findingsWith({
        "integrations/turn/package.json": { name: "@acme/turn" },
        "integrations/turn/src/index.ts": "export {}\n",
        "package.json": rootWith("integrations/*"),
      }),
    ).toEqual(["package-without-kind @acme/turn"])
  })

  it("reads a package's name from package.json, not its directory", () => {
    const twin = {
      "tools/web/package.json": { name: "@acme/tool-web", dependencies: { "@acme/web": "workspace:*" } },
      "tools/web/src/index.ts": 'import "@acme/web"\n',
    }
    expect(findingsWith(twin)).toEqual([])
  })
})

describe("relative imports", () => {
  it("rejects a relative import into a sibling package, even where the kind edge is allowed", () => {
    expect(findingsWith({ "apps/web/src/main.ts": 'import "../../../libraries/parcel/src/size.ts"\n' })).toEqual([
      "relative-import-leaves-package ../../../libraries/parcel/src/size.ts",
    ])
  })

  it("rejects an import that names no file", () => {
    expect(findingsWith({ [library]: 'import "./missing.ts"\n' })).toEqual(["unresolved-import ./missing.ts"])
  })
})

describe("outside packages, runtime and test-only modules", () => {
  it("rejects an outside package the kind does not allow in shipped code", () => {
    const declared = {
      "services/room/package.json": {
        name: "@acme/service-room",
        dependencies: { "@acme/parcel": "workspace:*", effect: "1", partyserver: "1" },
        devDependencies: { "@acme/conformance": "workspace:*" },
      },
    }
    expect(findingsWith({ ...declared, "services/room/src/party.ts": 'import "partyserver"\n' })).toEqual(["forbidden-external partyserver"])
  })

  it("rejects runtime modules in shipped library code, bare built-ins included, and allows them in development files", () => {
    for (const module of ["node:fs", "fs", "path/posix", "bun", "bun:sqlite", "cloudflare:workers"]) {
      expect(findingsWith({ "libraries/parcel/src/runtime.ts": `import "${module}"\n` }), module).toEqual([`runtime-module ${module}`])
    }

    expect(findingsWith({ "libraries/parcel/scripts/vectors.ts": 'import "node:fs"\n' })).toEqual([])
  })

  it("rejects a test-only module in shipped code unless the file is test support", () => {
    expect(findingsWith({ "apps/web/src/check.ts": 'import "fast-check"\n' })).toContain("test-only-in-shipped fast-check")
  })
})

describe("declarations", () => {
  it("rejects an import package.json does not declare", () => {
    expect(findingsWith({ [library]: 'import "valibot"\n' })).toEqual(["forbidden-external valibot", "undeclared-import valibot"])
  })

  it("rejects a devDependency or a root devDependency in shipped code and allows both in development files", () => {
    expect(findingsWith({ "platforms/cloudflare/src/deploy.ts": 'import "wrangler"\n' })).toEqual(["undeclared-import wrangler"])
    expect(findingsWith({ "apps/web/src/fuzz.ts": 'import "fast-check"\n' })).toEqual(["test-only-in-shipped fast-check", "undeclared-import fast-check"])
    expect(findingsWith({ "apps/web/test/fuzz.test.ts": 'import "fast-check"\n' })).toEqual([])
  })

  it("accepts @types for a type-only import", () => {
    const declared = { "apps/web/package.json": { name: "@acme/web", dependencies: { "@acme/parcel": "workspace:*", "@types/express": "1" } } }
    expect(findingsWith({ ...declared, "apps/web/src/types.ts": 'import type { Request } from "express"\nexport type R = Request\n' })).toEqual([])
  })
})

describe("computed imports", () => {
  it("rejects import() of an expression in shipped code and allows it in development files", () => {
    expect(findingsWith({ "apps/web/src/load.ts": "const name = './lazy.ts'\nexport const lazy = await import(name)\n" })).toEqual(["computed-import name"])
  })

  it("treats a literal written with an escape as computed, closing the bypass that reads its text", () => {
    const escaped = String.raw`export const parcel = await import("../../../libraries/parcel/src/\x73ize.ts")` + "\n"
    expect(findingsWith({ "apps/web/src/escape.ts": escaped })).toEqual([String.raw`computed-import "../../../libraries/parcel/src/\x73ize.ts"`])
  })

  it("reports import.meta.glob as computed until globs are read", () => {
    expect(findingsWith({ "apps/web/src/glob.ts": 'export const pages = import.meta.glob("./pages/*.ts")\n' })).toEqual([
      'computed-import import.meta.glob("./pages/*.ts")',
    ])
  })
})

describe("baseline", () => {
  it("tolerates a listed finding and fails on an entry nothing needs", () => {
    const baseline: Config = {
      ...validConfig,
      baseline: [{ file: library, rule: "undeclared-import", target: "valibot", reason: "moving to its own package" }],
    }
    expect(findingsWith({ [library]: 'import "valibot"\n' }, baseline)).toEqual(["forbidden-external valibot"])
    expect(findingsWith({}, baseline)).toEqual(["stale-baseline undeclared-import"])
  })
})

function rootWith(extra: string) {
  return {
    name: "acme",
    private: true,
    workspaces: ["libraries/*", "services/*", "platforms/*", "apps/*", "tools/*", extra],
    devDependencies: { "fast-check": "1.0.0" },
  }
}
