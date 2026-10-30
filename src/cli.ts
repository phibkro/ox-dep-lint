#!/usr/bin/env node
/**
 * `ox-dep-lint [--root <dir>] [--config <file>]`: checks the workspace and exits 1 on any finding. The configuration is
 * `ox-dep-lint.config.{ts,mts,js,mjs,json}` at the workspace root unless `--config` names one.
 */
import { existsSync, readFileSync } from "node:fs"
import nodePath from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { checkWorkspace, formatFinding } from "./check.ts"
import type { Config } from "./config.ts"
import { findWorkspaceRoot } from "./workspace.ts"

const configNames = ["ox-dep-lint.config.ts", "ox-dep-lint.config.mts", "ox-dep-lint.config.js", "ox-dep-lint.config.mjs", "ox-dep-lint.config.json"]

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)

  return index === -1 ? undefined : process.argv[index + 1]
}

export const loadConfig = async (path: string): Promise<Config> => {
  if (path.endsWith(".json")) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))

    // SAFETY: resolveConfig validates the shape it relies on and fails with the problems it finds.
    return parsed as Config
  }

  const loaded: unknown = await import(pathToFileURL(path).href)

  if (typeof loaded !== "object" || loaded === null || !("default" in loaded)) {
    throw new Error(`${path} has no default export`)
  }

  // SAFETY: as above, resolveConfig validates the configuration.
  return loaded.default as Config
}

const main = async () => {
  const root = argument("--root") ?? findWorkspaceRoot(process.cwd())

  if (root === undefined) {
    process.stderr.write("ox-dep-lint: no package.json with workspaces at or above this directory; pass --root\n")
    process.exitCode = 2

    return
  }

  const named = argument("--config")
  const configPath = named === undefined ? configNames.map((name) => nodePath.join(root, name)).find((path) => existsSync(path)) : nodePath.resolve(named)

  if (configPath === undefined) {
    process.stderr.write(`ox-dep-lint: no configuration (${configNames.join(", ")}) in ${root}\n`)
    process.exitCode = 2

    return
  }

  const started = performance.now()
  const result = checkWorkspace(root, await loadConfig(configPath))

  for (const finding of result.findings) {
    process.stdout.write(`${formatFinding(finding)}\n`)
  }

  const seconds = ((performance.now() - started) / 1000).toFixed(2)
  process.stdout.write(`ox-dep-lint: ${result.files} files, ${result.findings.length} findings (${seconds} s)\n`)
  process.exitCode = result.findings.length === 0 ? 0 : 1
}

try {
  await main()
} catch (error) {
  // A configuration or workspace problem is a message, not a stack trace.
  process.stderr.write(`ox-dep-lint: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
