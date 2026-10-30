/**
 * What the walk cannot see through: symbolic links (reported, never followed), directories it cannot list, and
 * directories the workspaces match that no package owns. Each case plants one thing in the valid workspace.
 */
import { chmodSync, mkdirSync, readdirSync, symlinkSync } from "node:fs"
import nodePath from "node:path"
import { describe, expect, it, vi } from "vite-plus/test"
import { checkWorkspace, listSourceFiles } from "../src/check.ts"
import type { Config } from "../src/config.ts"
import { defaultFileClasses } from "../src/config.ts"
import { createEngine } from "../src/engine.ts"
import type { Files } from "./support/workspace.ts"
import { removeWorkspace, validConfig, validWorkspace, writeWorkspace } from "./support/workspace.ts"

/** Directories whose listing fails with EACCES, whoever runs the test (root reads a directory whatever its mode). */
const denied = vi.hoisted(() => new Set<string>())

vi.mock(import("node:fs"), async (importOriginal) => {
  const actual = await importOriginal()
  // SAFETY: called only as a forwarder below, with the arguments of whichever overload the caller used.
  const forward = actual.readdirSync as (path: string, options?: unknown) => unknown
  const denying = (path: string, options?: unknown): unknown => {
    if (denied.has(String(path))) {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(path)}'`), { code: "EACCES" })
    }

    return forward(path, options)
  }
  // SAFETY: `denying` passes every call through unchanged (so it returns what that overload returns) or throws.
  const listing = denying as typeof actual.readdirSync

  return { ...actual, default: { ...actual, readdirSync: listing }, readdirSync: listing }
})

/** A path to link from (repository-relative) and the destination the link names, as written. */
type Links = Readonly<Record<string, string>>

/** The `rule file target` triples of a check of `validWorkspace` with `changes` and `links` planted, sorted. */
const check = (changes: Files, links: Links = {}, config: Config = validConfig, prepare: (root: string) => void = () => undefined): string[] => {
  const root = writeWorkspace({ ...validWorkspace, ...changes })

  try {
    for (const [path, destination] of Object.entries(links)) {
      mkdirSync(nodePath.dirname(nodePath.join(root, path)), { recursive: true })
      symlinkSync(destination, nodePath.join(root, path))
    }

    prepare(root)

    return checkWorkspace(root, config)
      .findings.map((finding) => `${finding.rule} ${finding.file} ${finding.target ?? ""}`.trim())
      .toSorted()
  } finally {
    denied.clear()
    removeWorkspace(root)
  }
}

/** Outside every package, and importing what a library may not: if the check followed a link here, it would say so. */
const elsewhere: Files = {
  "elsewhere/b.ts": 'import "@acme/platform-cloudflare"\nimport { readFileSync } from "node:fs"\nexport const read = readFileSync\n',
}

const source = "libraries/parcel/src"

describe("symbolic links under a package's checked files", () => {
  it("reports a link to a file, to a directory, a dangling link and a cycle, and follows none", () => {
    expect(
      check(elsewhere, {
        [`${source}/linked.ts`]: "../../../elsewhere/b.ts",
        [`${source}/shared`]: "../../../elsewhere",
        [`${source}/gone.ts`]: "missing.ts",
        [`${source}/loop`]: "loop",
        [`${source}/ping`]: "pong",
        [`${source}/pong`]: "ping",
        [`${source}/up`]: "..",
      }),
    ).toEqual([
      `symbolic-link ${source}/gone.ts missing.ts`,
      `symbolic-link ${source}/linked.ts ../../../elsewhere/b.ts`,
      `symbolic-link ${source}/loop loop`,
      `symbolic-link ${source}/ping pong`,
      `symbolic-link ${source}/pong ping`,
      `symbolic-link ${source}/shared ../../../elsewhere`,
      `symbolic-link ${source}/up ..`,
    ])
  })

  it("reports a link in a development file's place, which the check reads too", () => {
    expect(check(elsewhere, { "libraries/parcel/test/helper.ts": "../../../elsewhere/b.ts" })).toEqual([
      "symbolic-link libraries/parcel/test/helper.ts ../../../elsewhere/b.ts",
    ])
  })

  it("leaves the linked file out of the files it lists", () => {
    const root = writeWorkspace({ ...validWorkspace, ...elsewhere })

    try {
      symlinkSync("../../../elsewhere/b.ts", nodePath.join(root, source, "linked.ts"))
      expect(listSourceFiles(createEngine(root, validConfig))).not.toContain(`${source}/linked.ts`)
    } finally {
      removeWorkspace(root)
    }
  })

  it("negative control: a link where the check reads nothing is no finding", () => {
    const config: Config = {
      ...validConfig,
      ignore: ["libraries/parcel/vendor/**"],
      fileClasses: [{ files: ["fixtures/**"], policy: "unchecked" }, ...defaultFileClasses],
    }
    expect(
      check(
        elsewhere,
        {
          // Build output, a dependency, a dot directory, a file the check never reads, an ignored path, unchecked files.
          "libraries/parcel/dist/index.js": "../../../elsewhere/b.ts",
          "libraries/parcel/dist/chunks": "../../../elsewhere",
          "libraries/parcel/node_modules": "../../elsewhere",
          "libraries/parcel/.cache": "../../elsewhere",
          "libraries/parcel/README.md": "../../elsewhere/b.ts",
          "libraries/parcel/vendor/b.ts": "../../../elsewhere/b.ts",
          "libraries/parcel/vendor/all": "../../../elsewhere",
          "libraries/parcel/fixtures/b.ts": "../../../elsewhere/b.ts",
          "libraries/parcel/fixtures/deep/all": "../../../../elsewhere",
          // Outside every package, where the walk never goes.
          "elsewhere/again.ts": "b.ts",
        },
        config,
      ),
    ).toEqual([])
  })

  it("can be baselined, and a baseline entry no link needs is stale", () => {
    const baseline: Config = {
      ...validConfig,
      baseline: [{ file: `${source}/shared`, rule: "symbolic-link", target: "../../../elsewhere", reason: "a vendored copy, until it is published" }],
    }
    expect(check(elsewhere, { [`${source}/shared`]: "../../../elsewhere" }, baseline)).toEqual([])
    // Pointed elsewhere, the link is a new finding and the entry is stale.
    expect(check(elsewhere, { [`${source}/shared`]: "../../../elsewhere/." }, baseline)).toEqual([
      `stale-baseline ${source}/shared symbolic-link`,
      `symbolic-link ${source}/shared ../../../elsewhere/.`,
    ])
  })
})

describe("directories the walk cannot read", () => {
  it("reports a directory it cannot list instead of skipping it or failing", () => {
    expect(
      check({ [`${source}/locked/c.ts`]: 'import "@acme/platform-cloudflare"\n' }, {}, validConfig, (root) => {
        denied.add(nodePath.join(root, source, "locked"))
      }),
    ).toEqual([`unreadable-directory ${source}/locked ${source}/locked`])
  })

  it("negative control: an unreadable directory the check would not read anyway is no finding", () => {
    expect(
      check({ "libraries/parcel/dist/index.js": "export {}\n" }, {}, validConfig, (root) => {
        denied.add(nodePath.join(root, "libraries/parcel/dist"))
      }),
    ).toEqual([])
  })

  it("reports a directory whose mode forbids reading it (chmod 000)", (context) => {
    const root = writeWorkspace({ ...validWorkspace, [`${source}/locked/c.ts`]: 'import "@acme/platform-cloudflare"\n' })
    const locked = nodePath.join(root, source, "locked")

    try {
      chmodSync(locked, 0o000)

      try {
        readdirSync(locked)
        // Root, or a process with CAP_DAC_READ_SEARCH, reads it anyway; the case above covers that run.
        context.skip()
      } catch {
        // The mode holds for this process.
      }

      expect(checkWorkspace(root, validConfig).findings.map((finding) => `${finding.rule} ${finding.file}`)).toEqual([`unreadable-directory ${source}/locked`])
    } finally {
      chmodSync(locked, 0o755)
      removeWorkspace(root)
    }
  })
})

describe("directories the workspaces match that no package owns", () => {
  it("reports a directory without a package.json, with sources or empty", () => {
    expect(
      check({ "libraries/stray/src/x.ts": 'import "@acme/platform-cloudflare"\n' }, {}, validConfig, (root) => mkdirSync(nodePath.join(root, "tools/empty"))),
    ).toEqual(["directory-without-package libraries/stray libraries/stray", "directory-without-package tools/empty tools/empty"])
  })

  it("reports a link the workspaces match, which is never followed, and an unreadable directory there", () => {
    expect(
      check(
        { ...elsewhere, "elsewhere/package.json": { name: "@acme/elsewhere" }, "libraries/locked/src/x.ts": "export {}\n" },
        { "libraries/linked": "../elsewhere" },
        validConfig,
        (root) => {
          denied.add(nodePath.join(root, "libraries/locked"))
        },
      ),
    ).toEqual(["symbolic-link libraries/linked ../elsewhere", "unreadable-directory libraries/locked libraries/locked"])
  })

  it("negative control: an ignored, a negated and a nested directory, and a link to a file, are no finding", () => {
    const root = { ...(validWorkspace["package.json"] as object), workspaces: ["libraries/**", "services/*", "platforms/*", "apps/*", "tools/*", "!tools/old"] }
    const library = { packages: ["libraries/*", "libraries/group/*"], mayUse: ["library"], externals: ["effect", "fast-check"], runtimeModules: false }
    const config: Config = { ...validConfig, kinds: { ...validConfig.kinds, library }, ignore: ["libraries/stray/**"] }
    expect(
      check(
        {
          "package.json": root,
          "libraries/stray/src/x.ts": "export {}\n",
          "tools/old/script.ts": "export {}\n",
          "libraries/group/nested/package.json": { name: "@acme/nested" },
          "libraries/group/nested/src/index.ts": "export {}\n",
        },
        { "tools/README.md": "../package.json" },
        config,
      ),
    ).toEqual([])
  })

  it("can be baselined, and a baseline entry no directory needs is stale", () => {
    const baseline: Config = {
      ...validConfig,
      baseline: [
        { file: "tools/oxlint", rule: "directory-without-package", target: "tools/oxlint", reason: "a vendored oxlint plugin, until it is a package" },
      ],
    }
    expect(check({ "tools/oxlint/index.ts": "export {}\n" }, {}, baseline)).toEqual([])
    expect(check({}, {}, baseline)).toEqual(["stale-baseline tools/oxlint directory-without-package"])
  })
})
