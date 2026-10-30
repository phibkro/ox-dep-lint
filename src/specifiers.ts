/**
 * Every way a source file loads another module, read with oxc-parser. Adapted from `importSpecifiers.ts` of
 * phibkro/vektorprogrammet-reimagined (same author): it reads static imports, `export ... from`, `import("...")`, the
 * type-level `import("...")`, `import x = require("...")` and a string-named `declare module "..."`. Two rules close gaps
 * the earlier copies had: a specifier whose source text holds a backslash is computed (the text a check reads is not the
 * module it names; reebeat's check could be bypassed that way), and a template literal without a placeholder is a
 * plain string.
 */
import { parseSync, Visitor } from "oxc-parser"

export interface ImportSite {
  readonly line: number
  readonly column: number
  readonly specifier: string
  /** `import type`, `export type`, a type-level `import("...")` or `declare module`: no runtime edge. */
  readonly typeOnly: boolean
}

/** A load whose module no check can read: `import(name)`, an escaped literal, an `import.meta.glob`. */
export interface ComputedSite {
  readonly line: number
  readonly column: number
  readonly text: string
  readonly reason: string
}

export interface ImportForms {
  readonly imports: readonly ImportSite[]
  readonly computed: readonly ComputedSite[]
  readonly parseErrors: readonly string[]
}

const quoted = /^(?<quote>["'`])(?<value>[^"'`]*)\k<quote>$/u

/** Line (1-based) and column (0-based) of each offset, from the line starts of `text`. */
const locator = (text: string) => {
  const starts = [0]

  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1)
    }
  }

  return (offset: number): { line: number; column: number } => {
    let low = 0
    let high = starts.length - 1

    while (low < high) {
      const middle = Math.ceil((low + high) / 2)

      if ((starts[middle] ?? 0) <= offset) {
        low = middle
      } else {
        high = middle - 1
      }
    }

    return { line: low + 1, column: offset - (starts[low] ?? 0) }
  }
}

/** The value of a literal written as `raw`, or why it is computed. */
const literal = (raw: string): { value: string } | { reason: string } => {
  const trimmed = raw.trim()

  if (trimmed.includes("\\")) {
    return { reason: "it is written with an escape sequence, so its text is not the module it names" }
  }

  const value = quoted.exec(trimmed)?.groups?.value

  if (value === undefined || (trimmed.startsWith("`") && value.includes("${"))) {
    return { reason: "its module is an expression, not a plain string" }
  }

  return { value }
}

export const importForms = (path: string, text: string): ImportForms => {
  const { module, program, errors } = parseSync(path, text)
  const at = locator(text)
  const imports: ImportSite[] = []
  const computed: ComputedSite[] = []

  const add = (start: number, end: number, typeOnly: boolean) => {
    const read = literal(text.slice(start, end))
    const place = at(start)

    if ("value" in read) {
      imports.push({ ...place, specifier: read.value, typeOnly })
    } else {
      computed.push({ ...place, text: text.slice(start, end), reason: read.reason })
    }
  }

  for (const entry of module.staticImports) {
    const typeOnly = entry.entries.length > 0 && entry.entries.every((binding) => binding.isType)
    add(entry.moduleRequest.start, entry.moduleRequest.end, typeOnly)
  }

  for (const declaration of module.staticExports) {
    const requests = new Map<number, { end: number; typeOnly: boolean }>()

    for (const entry of declaration.entries) {
      if (entry.moduleRequest !== null) {
        const seen = requests.get(entry.moduleRequest.start)
        requests.set(entry.moduleRequest.start, { end: entry.moduleRequest.end, typeOnly: (seen?.typeOnly ?? true) && entry.isType })
      }
    }

    for (const [start, { end, typeOnly }] of requests) {
      add(start, end, typeOnly)
    }
  }

  for (const entry of module.dynamicImports) {
    add(entry.moduleRequest.start, entry.moduleRequest.end, false)
  }

  new Visitor({
    CallExpression(node) {
      if (text.slice(node.callee.start, node.callee.end).replaceAll(/\s+/gu, "") === "import.meta.glob") {
        computed.push({
          ...at(node.start),
          text: text.slice(node.start, node.end),
          reason: "import.meta.glob is not read yet, so the check cannot see what it loads",
        })
      }
    },
    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type === "TSExternalModuleReference") {
        add(node.moduleReference.expression.start, node.moduleReference.expression.end, node.importKind === "type")
      }
    },
    TSImportType(node) {
      add(node.source.start, node.source.end, true)
    },
    TSModuleDeclaration(node) {
      // `declare module "x"` augments the module it names; a wildcard (`"*.svg"`) declares a shape, not an edge.
      if (node.id.type === "Literal" && typeof node.id.value === "string" && !node.id.value.includes("*")) {
        add(node.id.start, node.id.end, true)
      }
    },
  }).visit(program)

  const byPlace = (left: { line: number; column: number }, right: { line: number; column: number }) => left.line - right.line || left.column - right.column

  return {
    imports: imports.toSorted(byPlace),
    computed: computed.toSorted(byPlace),
    parseErrors: errors.filter((error) => error.severity === "Error").map((error) => error.message),
  }
}
