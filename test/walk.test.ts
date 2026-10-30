/**
 * What the walk cannot see through: symbolic links (reported, never followed), directories it cannot list, and
 * directories the workspaces match that no package owns. Each case plants one thing in the valid workspace.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import nodePath from "node:path"
import { describe, expect, it, vi } from "vite-plus/test"
import { checkWorkspace, listSourceFiles } from "../src/check.ts"
import type { Config } from "../src/config.ts"
import { defaultFileClasses } from "../src/config.ts"
import { createEngine, findingsForFile } from "../src/engine.ts"
import type { Files } from "./support/workspace.ts"
import { removeWorkspace, validConfig, validWorkspace, writeWorkspace, writeWorkspaceFiles } from "./support/workspace.ts"

/** Paths whose listing or reading fails with EACCES, whoever runs the test (root reads a path whatever its mode). */
const denied = vi.hoisted(() => new Set<string>())

/**
 * Changes to the disk to make right after one call returns, keyed by `operation absolute-path` (`readdirSync /tmp/x/src`),
 * each made once. So a test removes an entry after the check listed or found it and before it reads it, as a test
 * running beside the check did in tsukuri, without relying on a race.
 */
const afterCall = vi.hoisted(() => new Map<string, () => void>())

vi.mock(import("node:fs"), async (importOriginal) => {
  const actual = await importOriginal()
  /**
   * `call` with its arguments unchanged, then the change `afterCall` holds for it. With a `syscall`, a path in `denied`
   * throws the error a mode of 000 gives instead.
   */
  const instrumented =
    (call: (path: string, options?: unknown) => unknown, operation: string, syscall?: string) =>
    (path: string, options?: unknown): unknown => {
      if (syscall !== undefined && denied.has(String(path))) {
        throw Object.assign(new Error(`EACCES: permission denied, ${syscall} '${String(path)}'`), { code: "EACCES" })
      }

      const result = call(path, options)
      const key = `${operation} ${String(path)}`
      const change = afterCall.get(key)

      if (change !== undefined) {
        afterCall.delete(key)
        change()
      }

      return result
    }
  // SAFETY: each wrapper passes every call through unchanged (so it returns what that overload returns) or throws.
  const readdirSync = instrumented(actual.readdirSync as (path: string, options?: unknown) => unknown, "readdirSync", "scandir") as typeof actual.readdirSync
  // SAFETY: as above.
  const readFileSync = instrumented(actual.readFileSync as (path: string, options?: unknown) => unknown, "readFileSync", "open") as typeof actual.readFileSync
  // SAFETY: as above.
  const existsSync = instrumented(actual.existsSync as (path: string, options?: unknown) => unknown, "existsSync") as typeof actual.existsSync
  // SAFETY: as above.
  const statSync = instrumented(actual.statSync as (path: string, options?: unknown) => unknown, "statSync") as typeof actual.statSync
  // SAFETY: as above.
  const lstatSync = instrumented(actual.lstatSync as (path: string, options?: unknown) => unknown, "lstatSync") as typeof actual.lstatSync
  // SAFETY: as above.
  const readlinkSync = instrumented(
    actual.readlinkSync as (path: string, options?: unknown) => unknown,
    "readlinkSync",
    "readlink",
  ) as typeof actual.readlinkSync
  const replaced = { readdirSync, readFileSync, existsSync, statSync, lstatSync, readlinkSync }

  return { ...actual, default: { ...actual, ...replaced }, ...replaced }
})

/** Makes `change` right after the `nth` `operation` on the repository-relative `path` under `root` returns. */
const after = (operation: string, root: string, path: string, change: () => void, nth = 1) => {
  afterCall.set(`${operation} ${nodePath.join(root, path)}`, nth === 1 ? change : () => after(operation, root, path, change, nth - 1))
}

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
    afterCall.clear()
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

  it("reports a link whatever it points at or is named, in a dot directory too", () => {
    const config: Config = { ...validConfig, fileClasses: [{ files: ["**/*.d.ts"], policy: "unchecked" }, ...defaultFileClasses] }
    expect(
      check(
        elsewhere,
        {
          "libraries/parcel/src/types.d.ts": "../../../elsewhere/b.ts",
          "libraries/parcel/README.md": "../../elsewhere/b.ts",
          "libraries/parcel/data.json": "../../elsewhere/b.ts",
          "libraries/parcel/LICENSE": "../../elsewhere/b.ts",
          "libraries/parcel/.cache": "../../elsewhere",
          "libraries/parcel/src/.internal/linked.ts": "../../../../elsewhere/b.ts",
        },
        config,
      ),
    ).toEqual([
      "symbolic-link libraries/parcel/.cache ../../elsewhere",
      "symbolic-link libraries/parcel/LICENSE ../../elsewhere/b.ts",
      "symbolic-link libraries/parcel/README.md ../../elsewhere/b.ts",
      "symbolic-link libraries/parcel/data.json ../../elsewhere/b.ts",
      "symbolic-link libraries/parcel/src/.internal/linked.ts ../../../../elsewhere/b.ts",
      "symbolic-link libraries/parcel/src/types.d.ts ../../../elsewhere/b.ts",
    ])
  })

  it("negative control: a link in a directory the check skips on purpose is no finding", () => {
    const config: Config = {
      ...validConfig,
      ignore: ["libraries/parcel/vendor/**"],
      fileClasses: [{ files: ["fixtures/**"], policy: "unchecked" }, ...defaultFileClasses],
    }
    expect(
      check(
        elsewhere,
        {
          // Build output, dependencies, git's data, an ignored directory, unchecked files.
          "libraries/parcel/dist/index.js": "../../../elsewhere/b.ts",
          "libraries/parcel/dist/chunks": "../../../elsewhere",
          "libraries/parcel/node_modules": "../../elsewhere",
          "libraries/parcel/.git/hooks": "../../../elsewhere",
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

describe("dot directories", () => {
  it("checks the sources in a dot directory, and skips only .git and node_modules", () => {
    expect(
      check({
        [`${source}/.internal/x.ts`]: 'import "@acme/platform-cloudflare"\n',
        "libraries/parcel/.git/hooks/x.ts": 'import "@acme/platform-cloudflare"\n',
        "libraries/parcel/node_modules/x/index.ts": 'import "@acme/platform-cloudflare"\n',
      }),
    ).toEqual([`forbidden-edge ${source}/.internal/x.ts @acme/platform-cloudflare`, `undeclared-import ${source}/.internal/x.ts @acme/platform-cloudflare`])
  })
})

describe("dot directories a workspaces glob would match", () => {
  it("reports one, with or without a package.json, as no package, and reads nothing in it", () => {
    expect(
      check({
        "tools/.template/x.ts": 'import { readFileSync } from "node:fs"\nimport "@acme/ghost"\n',
        "libraries/.template/package.json": { name: "@acme/template" },
        "libraries/.template/src/index.ts": 'import { readFileSync } from "node:fs"\nexport const read = readFileSync\n',
        "tools/.git/x.ts": 'import "@acme/ghost"\n',
      }),
    ).toEqual(["directory-without-package libraries/.template libraries/.template", "directory-without-package tools/.template tools/.template"])
  })
})

describe("tool caches under a package", () => {
  // As wrangler writes them: a bundle importing runtime modules and absolute paths into dist and node_modules.
  const wrangler = (root: string): Files => ({
    "platforms/cloudflare/.wrangler/tmp/bundle-x/index.js":
      'import { DurableObject } from "cloudflare:workers"\nimport { Effect } from "effect"\nimport "@acme/web"\nexport class RoomObject extends DurableObject {}\nexport const e = Effect\n',
    "platforms/cloudflare/.wrangler/tmp/bundle-x/middleware-loader.entry.ts": `import worker from "${root}/platforms/cloudflare/dist/worker.js"\nimport * as drain from "${root}/node_modules/wrangler/templates/middleware/drain.ts"\nexport default [worker, drain]\n`,
  })

  it("does not read .wrangler and the other caches by default", () => {
    const root = writeWorkspace(validWorkspace)

    try {
      writeWorkspaceFiles(root, wrangler(root))
      expect(checkWorkspace(root, validConfig).findings).toEqual([])
    } finally {
      removeWorkspace(root)
    }
  })

  it("reads them when output replaces the defaults", () => {
    const root = writeWorkspace(validWorkspace)

    try {
      writeWorkspaceFiles(root, wrangler(root))
      expect(checkWorkspace(root, { ...validConfig, output: ["dist/**"] }).findings.map((finding) => finding.rule)).toContain("forbidden-edge")
    } finally {
      removeWorkspace(root)
    }
  })
})

describe("directories the walk cannot read", () => {
  it("reports a directory it cannot list instead of skipping it or failing", () => {
    expect(
      check({ [`${source}/locked/c.ts`]: 'import "@acme/platform-cloudflare"\n' }, {}, validConfig, (root) => {
        denied.add(nodePath.join(root, source, "locked"))
      }),
    ).toEqual([`unreadable-path ${source}/locked ${source}/locked`])
  })

  it("negative control: an unreadable directory the check would not read anyway is no finding", () => {
    expect(
      check({ "libraries/parcel/dist/index.js": "export {}\n" }, {}, validConfig, (root) => {
        denied.add(nodePath.join(root, "libraries/parcel/dist"))
      }),
    ).toEqual([])
  })

  it("reports a directory a workspaces glob cannot list, and the glob's base, instead of failing", () => {
    const root = { ...(validWorkspace["package.json"] as object), workspaces: ["libraries/**", "services/*", "platforms/*", "apps/*", "tools/*", "extras/*"] }
    expect(
      check(
        {
          "package.json": root,
          [`${source}/locked/c.ts`]: "export {}\n",
          "libraries/stray/locked/c.ts": "export {}\n",
          "libraries/attic/locked/c.ts": "export {}\n",
          "extras/one/c.ts": "export {}\n",
        },
        {},
        { ...validConfig, ignore: ["libraries/attic/**"] },
        (workspace) => {
          for (const directory of [`${source}/locked`, "libraries/stray/locked", "libraries/attic/locked", "extras"]) {
            denied.add(nodePath.join(workspace, directory))
          }
        },
      ),
    ).toEqual([
      "directory-without-package libraries/stray libraries/stray",
      "unreadable-path extras extras",
      // Inside a member, once: the walk reports it, and the glob leaves it to the walk.
      `unreadable-path ${source}/locked ${source}/locked`,
    ])
  })

  it("reports a source file it cannot read instead of failing", () => {
    expect(
      check({}, {}, validConfig, (root) => {
        denied.add(nodePath.join(root, source, "size.ts"))
      }),
    ).toEqual([`unreadable-path ${source}/size.ts ${source}/size.ts`])
  })

  it("reports a file whose mode forbids reading it (chmod 000)", (context) => {
    const root = writeWorkspace(validWorkspace)
    const locked = nodePath.join(root, source, "size.ts")

    try {
      chmodSync(locked, 0o000)

      try {
        readFileSync(locked)
        // Root, or a process with CAP_DAC_OVERRIDE, reads it anyway; the case above covers that run.
        context.skip()
      } catch {
        // The mode holds for this process.
      }

      expect(checkWorkspace(root, validConfig).findings.map((finding) => `${finding.rule} ${finding.file}`)).toEqual([`unreadable-path ${source}/size.ts`])
    } finally {
      chmodSync(locked, 0o644)
      removeWorkspace(root)
    }
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

      expect(checkWorkspace(root, validConfig).findings.map((finding) => `${finding.rule} ${finding.file}`)).toEqual([`unreadable-path ${source}/locked`])
    } finally {
      chmodSync(locked, 0o755)
      removeWorkspace(root)
    }
  })
})

describe("paths that disappear while the check runs", () => {
  /** What a library may not import: had the check read a file that disappeared, it would say so. */
  const forbidden = 'import "@acme/platform-cloudflare"\n'
  const remove = (root: string, path: string) => () => rmSync(nodePath.join(root, path), { recursive: true, force: true })
  /** Removes the directory at `path` and writes a file in its place, so a read through it fails with ENOTDIR. */
  const replaceWithFile = (root: string, path: string) => () => {
    rmSync(nodePath.join(root, path), { recursive: true, force: true })
    writeFileSync(nodePath.join(root, path), "")
  }

  it("skips a source file removed between listing and reading (ENOENT)", () => {
    expect(
      check({ [`${source}/vanishing.ts`]: forbidden }, {}, validConfig, (root) => after("readdirSync", root, source, remove(root, `${source}/vanishing.ts`))),
    ).toEqual([])
  })

  it("skips a directory removed between listing its parent and listing it (tsukuri's .scan-x)", () => {
    expect(
      check({ "tools/quality/.scan-x/packages/probe/src/index.ts": "export {}\n" }, {}, validConfig, (root) =>
        after("readdirSync", root, "tools/quality", remove(root, "tools/quality/.scan-x")),
      ),
    ).toEqual([])
  })

  it("skips a directory replaced by a file before it is listed (ENOTDIR)", () => {
    expect(
      check({ [`${source}/deep/x.ts`]: forbidden }, {}, validConfig, (root) => after("readdirSync", root, source, replaceWithFile(root, `${source}/deep`))),
    ).toEqual([])
  })

  it("skips a source file whose directory is replaced by a file before it is read (ENOTDIR)", () => {
    expect(
      check({ [`${source}/deep/x.ts`]: forbidden }, {}, validConfig, (root) =>
        after("readdirSync", root, `${source}/deep`, replaceWithFile(root, `${source}/deep`)),
      ),
    ).toEqual([])
  })

  it("skips a symbolic link removed before its destination is read", () => {
    expect(
      check({ ...elsewhere }, { [`${source}/link`]: "../../../elsewhere" }, validConfig, (root) =>
        after("readdirSync", root, source, remove(root, `${source}/link`)),
      ),
    ).toEqual([])
  })

  it("skips a development file removed between the shipped import that reaches it and its read", () => {
    expect(
      check(
        { "apps/web/scripts/helper.ts": "export const helper = 1\n", "apps/web/src/uses.ts": 'export { helper } from "../scripts/helper.ts"\n' },
        {},
        validConfig,
        (root) => after("statSync", root, "apps/web/scripts/helper.ts", remove(root, "apps/web/scripts/helper.ts")),
      ),
    ).toEqual([])
  })

  it("skips a member removed between the workspaces glob matching it and its package.json being read", () => {
    expect(
      check({ "tools/gone/package.json": { name: "@acme/gone" }, "tools/gone/src/index.ts": "export {}\n" }, {}, validConfig, (root) =>
        after("existsSync", root, "tools/gone/package.json", remove(root, "tools/gone")),
      ),
    ).toEqual([])
  })

  it("skips a directory a ** workspaces glob lists and then loses", () => {
    const root = { ...(validWorkspace["package.json"] as object), workspaces: ["libraries/**", "services/*", "platforms/*", "apps/*", "tools/*"] }
    expect(
      check({ "package.json": root, "libraries/gone/a/x.ts": "export {}\n" }, {}, validConfig, (workspace) =>
        // The third listing of libraries: the workspace's, the library kind's, then the one that reports what it cannot list.
        after("readdirSync", workspace, "libraries", remove(workspace, "libraries/gone"), 3),
      ),
    ).toEqual([])
  })

  it("skips, as the plugin does per file, a link removed before its destination is read", () => {
    const root = writeWorkspace({ ...validWorkspace, ...elsewhere })

    try {
      symlinkSync("../../../elsewhere", nodePath.join(root, source, "shared"))
      const engine = createEngine(root, validConfig)
      after("lstatSync", root, `${source}/shared`, remove(root, `${source}/shared`))
      // oxlint hands the plugin the text of a file it reached through the link; the link is gone before it is named.
      expect(findingsForFile(engine, `${source}/shared/b.ts`, forbidden)).toEqual([])
    } finally {
      afterCall.clear()
      removeWorkspace(root)
    }
  })

  it("negative control: a source file that becomes unreadable (EACCES) between listing and reading is still a finding", () => {
    expect(
      check({}, {}, validConfig, (root) =>
        after("readdirSync", root, source, () => {
          denied.add(nodePath.join(root, source, "size.ts"))
        }),
      ),
    ).toEqual([`unreadable-path ${source}/size.ts ${source}/size.ts`])
  })

  it("negative control: a member's package.json that becomes unreadable (EACCES) after the glob found it is still invalid-package", () => {
    expect(
      check({}, {}, validConfig, (root) =>
        after("existsSync", root, "tools/quality/package.json", () => {
          denied.add(nodePath.join(root, "tools/quality/package.json"))
        }),
      ),
    ).toEqual(["invalid-package tools/quality/package.json tools/quality"])
  })

  it("negative control: a development file that becomes unreadable (EACCES) before shipped code's import of it is judged is still a finding", () => {
    expect(
      check(
        { "apps/web/scripts/helper.ts": "export const helper = 1\n", "apps/web/src/uses.ts": 'export { helper } from "../scripts/helper.ts"\n' },
        {},
        validConfig,
        (root) =>
          after("statSync", root, "apps/web/scripts/helper.ts", () => {
            denied.add(nodePath.join(root, "apps/web/scripts/helper.ts"))
          }),
      ),
    ).toEqual(["shipped-imports-development-file apps/web/src/uses.ts ../scripts/helper.ts"])
  })

  it("negative control: a symbolic link whose destination cannot be read (EACCES) is still a finding", () => {
    expect(
      check({ ...elsewhere }, { [`${source}/link`]: "../../../elsewhere" }, validConfig, (root) => {
        denied.add(nodePath.join(root, source, "link"))
      }),
    ).toEqual([`symbolic-link ${source}/link an unreadable destination`])
  })

  it("negative control: a directory that becomes unreadable (EACCES) between listing its parent and listing it is still a finding", () => {
    expect(
      check({ [`${source}/locked/c.ts`]: forbidden }, {}, validConfig, (root) =>
        after("readdirSync", root, source, () => {
          denied.add(nodePath.join(root, source, "locked"))
        }),
      ),
    ).toEqual([`unreadable-path ${source}/locked ${source}/locked`])
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
    ).toEqual(["symbolic-link libraries/linked ../elsewhere", "unreadable-path libraries/locked libraries/locked"])
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

  it("under a ** glob, leaves links in a member to the walk: once, and not where it skips", () => {
    const root = { ...(validWorkspace["package.json"] as object), workspaces: ["libraries/**", "services/*", "platforms/*", "apps/*", "tools/*"] }
    const config: Config = { ...validConfig, fileClasses: [{ files: ["fixtures/**"], policy: "unchecked" }, ...defaultFileClasses] }
    expect(
      check(
        { ...elsewhere, "package.json": root },
        {
          [`${source}/link`]: "../../../elsewhere",
          "libraries/parcel/dist/link": "../../../elsewhere",
          "libraries/parcel/fixtures/link": "../../../elsewhere",
          "libraries/parcel/test/link": "../../../elsewhere",
          "libraries/parcel/node_modules": "../../elsewhere",
          "libraries/node_modules": "../elsewhere",
          "libraries/linked": "../elsewhere",
        },
        config,
      ),
    ).toEqual([
      "symbolic-link libraries/linked ../elsewhere",
      `symbolic-link ${source}/link ../../../elsewhere`,
      "symbolic-link libraries/parcel/test/link ../../../elsewhere",
    ])
  })

  it("reports a link a workspaces entry names literally, and does not follow it", () => {
    const root = {
      ...(validWorkspace["package.json"] as object),
      workspaces: ["libraries/*", "services/*", "platforms/*", "apps/*", "tools/*", "extras/linked"],
    }
    expect(check({ ...elsewhere, "elsewhere/package.json": { name: "@acme/elsewhere" }, "package.json": root }, { "extras/linked": "../elsewhere" })).toEqual([
      "symbolic-link extras/linked ../elsewhere",
    ])
  })

  it("reports only the topmost of nested directories no package owns", () => {
    const root = { ...(validWorkspace["package.json"] as object), workspaces: ["libraries/**", "services/*", "platforms/*", "apps/*", "tools/*"] }
    expect(
      check({ "package.json": root }, {}, validConfig, (workspace) => mkdirSync(nodePath.join(workspace, "libraries/empty/a/b"), { recursive: true })),
    ).toEqual(["directory-without-package libraries/empty libraries/empty"])
  })

  it("negative control: a negated glob ending in /** leaves the directory itself out", () => {
    const root = {
      ...(validWorkspace["package.json"] as object),
      workspaces: ["libraries/*", "services/*", "platforms/*", "apps/*", "tools/*", "!tools/legacy/**"],
    }
    expect(check({ "package.json": root, "tools/legacy/old.ts": "export {}\n" })).toEqual([])
  })

  it("reports a link a kind names literally, outside the workspaces", () => {
    const config: Config = { ...validConfig, kinds: { ...validConfig.kinds, extra: { packages: ["extras/linked"], mayUse: [] } } }
    expect(check({ ...elsewhere, "elsewhere/package.json": { name: "@acme/elsewhere" } }, { "extras/linked": "../elsewhere" }, config)).toEqual([
      "symbolic-link extras/linked ../elsewhere",
    ])
  })

  it("reports a glob's base that is a link, and finds no package through it", () => {
    const root = { ...(validWorkspace["package.json"] as object), workspaces: ["libraries/*", "services/*", "platforms/*", "apps/*", "tools/*", "extras/*"] }
    expect(
      check({ "package.json": root, "stash/one/package.json": { name: "@acme/one" }, "stash/one/src/index.ts": "export {}\n" }, { extras: "stash" }),
    ).toEqual(["symbolic-link extras stash"])
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
