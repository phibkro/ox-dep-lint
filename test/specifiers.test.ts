import { describe, expect, it } from "vite-plus/test"
import { importForms } from "../src/specifiers.ts"

const read = (source: string) => {
  const forms = importForms("example.ts", source)

  return { imports: forms.imports.map((site) => `${site.specifier}${site.typeOnly ? " (type)" : ""}`), computed: forms.computed.map((site) => site.text) }
}

describe("the specifier reader", () => {
  it("reads every form that loads a module, and which are type-only", () => {
    const source = [
      'import a from "a"',
      'import type { B } from "b"',
      'import { type C } from "c"',
      'import "side-effect"',
      'export { e } from "e"',
      'export type { F } from "f"',
      'export * from "g"',
      'export * as h from "h"',
      'export const i = await import("i")',
      "export const j = await import(`j`)",
      'export type K = typeof import("k")',
      'import l = require("l")',
      'declare module "m" {}',
      'declare module "*.svg" {}',
    ].join("\n")

    expect(read(source).imports).toEqual(["a", "b (type)", "c", "side-effect", "e", "f (type)", "g", "h", "i", "j", "k (type)", "l", "m (type)"])
  })

  it("treats an expression, a placeholder, an escape and a glob as computed", () => {
    const placeholder = ["$", "{name}"].join("")
    const source = [
      "await import(name)",
      `await import(\`./x${placeholder}.ts\`)`,
      String.raw`await import("./\x2e./y.ts")`,
      'import.meta.glob("./*.ts")',
    ].join("\n")
    // The escaped literal is read by what it spells, and its escape is reported.
    expect(read(source)).toEqual({
      imports: ["./../y.ts"],
      computed: ["name", `\`./x${placeholder}.ts\``, String.raw`"./\x2e./y.ts"`, 'import.meta.glob("./*.ts")'],
    })
  })

  it("reads a static import written with an escape as computed too", () => {
    // Built from parts, so the escape survives any tool that normalises string literals.
    const escaped = ['"', "\\", 'u0066s"'].join("")
    expect(read(`import ${escaped}`)).toEqual({ imports: ["fs"], computed: [escaped] })
  })
})
