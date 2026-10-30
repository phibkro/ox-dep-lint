/** The oxlint rule and the CLI read one engine, so under real oxlint they must report the same per-file findings. */
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import nodePath from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { checkWorkspace } from "../src/check.ts"
import { removeWorkspace, validConfig, validWorkspace, writeWorkspace } from "./support/workspace.ts"

const here = nodePath.dirname(new URL(import.meta.url).pathname)
const oxlint = nodePath.join(here, "../node_modules/.bin/oxlint")
const plugin = nodePath.join(here, "../src/plugin.ts")

const violations = {
  "services/room/src/index.ts": 'import "@acme/platform-cloudflare"\nexport * from "@acme/service-quota"\nexport const lazy = await import(`./x${1}.ts`)\n',
  "libraries/parcel/src/runtime.ts": 'import { readFileSync } from "fs"\nimport "./missing.ts"\nexport const read = readFileSync\n',
  "apps/web/src/main.ts": 'import "../../../libraries/parcel/src/size.ts"\nimport "fast-check"\n',
}

const lintedFindings = (root: string): string[] => {
  let output: string

  try {
    // A clean environment: under `vp test`, the variables Vite+ sets make a child oxlint lint nothing.
    output = execFileSync(oxlint, ["--format", "unix"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } })
  } catch (error) {
    // oxlint exits 1 when it reports anything; its report is still on stdout.
    // SAFETY: execFileSync throws an error carrying the child's stdout when it exits non-zero.
    output = (error as { stdout: string }).stdout
  }

  return output
    .split("\n")
    .map((line) => /^(?<place>[^:]+:\d+:\d+): (?<rule>[a-z-]+):/u.exec(line)?.groups)
    .filter((groups) => groups !== undefined)
    .map((groups) => `${groups.place} ${groups.rule}`)
    .toSorted()
}

describe("the oxlint plugin", () => {
  it("reports exactly the CLI's per-file findings, at the same places", () => {
    const root = writeWorkspace({ ...validWorkspace, ...violations })

    try {
      writeFileSync(
        nodePath.join(root, ".oxlintrc.json"),
        JSON.stringify({ plugins: [], jsPlugins: [plugin], rules: { "dep-lint/imports": ["error", validConfig] } }),
      )
      const cli = checkWorkspace(root, validConfig)
        .findings.filter((finding) => !finding.file.endsWith("package.json"))
        .map((finding) => `${finding.file}:${finding.line}:${finding.column + 1} ${finding.rule}`)
        .toSorted()

      expect(cli.length).toBeGreaterThanOrEqual(8)
      expect(lintedFindings(root)).toEqual(cli)
    } finally {
      removeWorkspace(root)
    }
  }, 30_000)
})
