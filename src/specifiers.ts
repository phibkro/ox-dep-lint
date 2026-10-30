/**
 * Every way a source file loads another module, read with oxc-parser. Adapted from `importSpecifiers.ts` of
 * phibkro/vektorprogrammet-reimagined (same author), and widened after the review of 0.1.0:
 *
 * - module syntax: `import`, `export ... from`, `import()`, the type-level `import("...")`, `import x = require("...")`,
 *   a string-named `declare module "..."`, and `/// <reference types="..." />`;
 * - loaders: `require`, `require.resolve`, `module.require`, `import.meta.require`, `import.meta.resolve`,
 *   `process.getBuiltinModule`, a `createRequire(...)` call applied directly, and `new URL("...", import.meta.url)`
 *   (how Vite and browsers load workers and assets);
 * - a specifier is checked by the string it spells (the parser's decoded value), so an escape sequence cannot disguise
 *   it; the escape is reported as well, since its source text is not the module it loads.
 *
 * Only `import type` and `export type` declarations are type-only. An inline `import { type X }` still loads the module
 * under `verbatimModuleSyntax`, so it counts as a value edge.
 */
import { parseSync, Visitor } from "oxc-parser"

/** Where something is written: line (1-based), column (0-based) and the offsets of its text. */
export interface Place {
  readonly line: number
  readonly column: number
  readonly start: number
  readonly end: number
}

export interface ImportSite extends Place {
  readonly specifier: string
  /** `import type`, `export type`, a type-level `import("...")`, `declare module` or a types reference: no runtime edge. */
  readonly typeOnly: boolean
}

/** A load whose module no check can read: `import(name)`, an escaped literal, an `import.meta.glob`, `createRequire`. */
export interface ComputedSite extends Place {
  readonly text: string
  readonly reason: string
}

export interface ImportForms {
  readonly imports: readonly ImportSite[]
  readonly computed: readonly ComputedSite[]
  readonly parseErrors: readonly string[]
}

interface Spanned {
  readonly start: number
  readonly end: number
}

interface LiteralLike extends Spanned {
  readonly type: string
  readonly value?: unknown
  readonly expressions?: readonly unknown[]
  readonly quasis?: readonly { readonly value: { readonly cooked?: string | null } }[]
}

/** Calls whose first argument names a module. */
const loaders = new Set(["require", "require.resolve", "module.require", "import.meta.require", "import.meta.resolve", "process.getBuiltinModule"])

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

/** The string a node spells: a string literal, or a template literal without placeholders; undefined otherwise. */
const spelled = (node: LiteralLike): string | undefined => {
  if ((node.type === "Literal" || node.type === "StringLiteral") && typeof node.value === "string") {
    return node.value
  }

  if (node.type === "TemplateLiteral" && node.expressions?.length === 0) {
    return node.quasis?.[0]?.value.cooked ?? undefined
  }

  return undefined
}

const compact = (text: string) => text.replaceAll(/\s+/gu, "")

const typesReference = /^\/\s*<reference\s+types\s*=\s*["'](?<name>[^"']+)["']\s*\/>/u

export const importForms = (path: string, source: string): ImportForms => {
  // A byte order mark is not part of the program; oxlint reports places in the text after it too.
  const text = source.startsWith("﻿") ? source.slice(1) : source
  const { program, comments, errors } = parseSync(path, text)
  const at = locator(text)
  const imports: ImportSite[] = []
  const computed: ComputedSite[] = []

  const add = (node: LiteralLike, typeOnly: boolean) => {
    const place = { ...at(node.start), start: node.start, end: node.end }
    const written = text.slice(node.start, node.end)
    const value = spelled(node)

    if (value === undefined) {
      computed.push({ ...place, text: written, reason: "its module is an expression, not a plain string" })

      return
    }

    imports.push({ ...place, specifier: value, typeOnly })

    if (written.includes("\\")) {
      computed.push({ ...place, text: written, reason: `it is written with an escape sequence, so its text is not the module it loads (${value})` })
    }
  }

  // `createRequire(import.meta.url)("x")` is read as a require of "x"; the inner call is then not a finding of its own.
  const appliedCreateRequire = new Set<number>()

  const refuse = (node: Spanned, reason: string) => {
    computed.push({ ...at(node.start), start: node.start, end: node.end, text: text.slice(node.start, node.end), reason })
  }

  new Visitor({
    ImportDeclaration(node) {
      add(node.source, node.importKind === "type")
    },
    ExportNamedDeclaration(node) {
      if (node.source !== null) {
        add(node.source, node.exportKind === "type")
      }
    },
    ExportAllDeclaration(node) {
      add(node.source, node.exportKind === "type")
    },
    ImportExpression(node) {
      add(node.source, false)
    },
    CallExpression(node) {
      const callee = compact(text.slice(node.callee.start, node.callee.end))
      const [first] = node.arguments

      if (callee === "import.meta.glob") {
        refuse(node, "import.meta.glob is not read yet, so the check cannot see what it loads")
      } else if (loaders.has(callee) || /^(?:module\.)?createRequire\(.*\)$/su.test(callee)) {
        appliedCreateRequire.add(node.callee.start)

        if (first === undefined || first.type === "SpreadElement") {
          refuse(node, "it names no module the check can read")
        } else {
          add(first, false)
        }
      } else if (/^(?:module\.)?createRequire$/u.test(callee) && !appliedCreateRequire.has(node.start)) {
        refuse(node, "a require function made by createRequire loads modules the check cannot follow")
      }
    },
    NewExpression(node) {
      const [first, second] = node.arguments

      if (
        compact(text.slice(node.callee.start, node.callee.end)) === "URL" &&
        second !== undefined &&
        compact(text.slice(second.start, second.end)) === "import.meta.url"
      ) {
        const directory = first !== undefined && first.type !== "SpreadElement" && /(?:^|\/)\.{0,2}\/?$/u.test(spelled(first) ?? "x")

        if (first === undefined || first.type === "SpreadElement") {
          refuse(node, "it names no file the check can read")
        } else if (!directory) {
          // A URL of a directory (`new URL("../", import.meta.url)`) locates files on disk; it loads no module.
          add(first, false)
        }
      }
    },
    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type === "TSExternalModuleReference") {
        add(node.moduleReference.expression, node.importKind === "type")
      }
    },
    TSImportType(node) {
      add(node.source, true)
    },
    TSModuleDeclaration(node) {
      // `declare module "x"` augments the module it names; a wildcard (`"*.svg"`) declares a shape, not an edge.
      if (node.id.type === "Literal" && typeof node.id.value === "string" && !node.id.value.includes("*")) {
        add(node.id, true)
      }
    },
  }).visit(program)

  for (const comment of comments) {
    const name = comment.type === "Line" ? typesReference.exec(comment.value.trim())?.groups?.name : undefined

    if (name !== undefined) {
      imports.push({ ...at(comment.start), start: comment.start, end: comment.end, specifier: name, typeOnly: true })
    }
  }

  const byPlace = (left: { line: number; column: number }, right: { line: number; column: number }) => left.line - right.line || left.column - right.column

  return {
    imports: imports.toSorted(byPlace),
    computed: computed.toSorted(byPlace),
    parseErrors: errors.filter((error) => error.severity === "Error").map((error) => error.message),
  }
}
