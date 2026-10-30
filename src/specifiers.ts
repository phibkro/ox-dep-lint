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

/** Calls that load the module their first argument names. */
const loaders = new Set([
  "require",
  "module.require",
  "import.meta.require",
  "process.getBuiltinModule",
  "globalThis.require",
  "global.require",
  "window.require",
  "self.require",
])

/** Calls that only locate a module: a literal argument is still an edge, a computed one loads nothing. */
const locators = new Set(["require.resolve", "import.meta.resolve"])

/** `(require)`, `(0, require)` and `( require )` are `require`. */
const plainCallee = (callee: string) => callee.replace(/^\((?:0,)?(.*)\)$/su, "$1").replaceAll("?.", ".")

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
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source
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
  // `require` in a value position: passed, stored or returned, so the check cannot follow what it loads.
  const sequenceCallees = new Set<number>()

  const requireValue = (node: object | null | undefined) => {
    const candidate: { type?: unknown; name?: unknown; start?: unknown; end?: unknown } = node ?? {}

    if (candidate.type === "Identifier" && candidate.name === "require" && typeof candidate.start === "number" && typeof candidate.end === "number") {
      refuse({ start: candidate.start, end: candidate.end }, "require is used as a value, so the check cannot follow what it loads")
    }
  }

  /** The `new URL(...)` inside `new URL(...).href` or `new URL(...).toString()`. */
  const innermostUrl = (node: LiteralLike | undefined): LiteralLike | undefined => {
    const shaped = node as (LiteralLike & { readonly object?: LiteralLike; readonly callee?: LiteralLike }) | undefined

    if (shaped?.type === "MemberExpression") {
      return shaped.object
    }

    if (shaped?.type === "CallExpression" && shaped.callee?.type === "MemberExpression") {
      return innermostUrl(shaped.callee)
    }

    return node
  }

  /**
   * `new Worker(new URL("./x.ts", import.meta.url))` loads x.ts as a module, extension or not (bundlers resolve it). A
   * `new URL(..., import.meta.url)` anywhere else locates a file to read or an asset to serve, and loads nothing.
   */
  const readWorkerUrl = (argument: LiteralLike | undefined) => {
    // `new URL(...).href` and `new URL(...).toString()` are the same URL, as Vite and Bun both accept.
    const unwrapped = /^(?<url>new\s*URL\s*\([\s\S]*\))\s*(?:\.\s*href|\.\s*toString\s*\(\s*\))$/u.test(
      argument === undefined ? "" : text.slice(argument.start, argument.end),
    )
      ? innermostUrl(argument)
      : argument
    const url = unwrapped as (LiteralLike & { readonly callee?: Spanned; readonly arguments?: readonly LiteralLike[] }) | undefined

    if (url?.type !== "NewExpression" || url.callee === undefined || compact(text.slice(url.callee.start, url.callee.end)) !== "URL") {
      return
    }

    const [first, second] = url.arguments ?? []

    if (first === undefined || second === undefined || compact(text.slice(second.start, second.end)) !== "import.meta.url") {
      return
    }

    const value = spelled(first)

    if (value === undefined || /^(?:\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/iu.test(value)) {
      add(first, false)
    } else {
      // A URL is relative to the file even without `./`; as an import specifier that would name a package.
      imports.push({ ...at(first.start), start: first.start, end: first.end, specifier: `./${value}`, typeOnly: false })
    }
  }

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
      const callee = plainCallee(compact(text.slice(node.callee.start, node.callee.end)))
      const [first] = node.arguments

      for (const argument of node.arguments) {
        requireValue(argument)
      }

      if (node.callee.type === "SequenceExpression") {
        sequenceCallees.add(node.callee.start)
      } else if (node.callee.type === "ParenthesizedExpression" && node.callee.expression.type === "SequenceExpression") {
        sequenceCallees.add(node.callee.expression.start)
      }

      if (callee === "navigator.serviceWorker.register") {
        readWorkerUrl(first?.type === "SpreadElement" ? undefined : first)
      } else if (locators.has(callee)) {
        if (first !== undefined && first.type !== "SpreadElement" && spelled(first) !== undefined) {
          add(first, false)
        }
      } else if (callee === "import.meta.glob") {
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
      const callee = compact(text.slice(node.callee.start, node.callee.end))

      if (callee === "Worker" || callee === "SharedWorker") {
        readWorkerUrl(node.arguments[0])
      }
    },
    VariableDeclarator(node) {
      requireValue(node.init)
    },
    AssignmentExpression(node) {
      requireValue(node.right)
    },
    ArrayExpression(node) {
      for (const element of node.elements) {
        requireValue(element)
      }
    },
    ObjectExpression(node) {
      // `{ require }` and `{ load: require }` pass the loader along; a destructuring pattern is not an ObjectExpression.
      for (const property of node.properties) {
        requireValue(property.type === "Property" ? property.value : property.argument)
      }
    },
    ReturnStatement(node) {
      requireValue(node.argument)
    },
    ArrowFunctionExpression(node) {
      requireValue(node.expression ? node.body : undefined)
    },
    ConditionalExpression(node) {
      requireValue(node.consequent)
      requireValue(node.alternate)
    },
    LogicalExpression(node) {
      requireValue(node.left)
      requireValue(node.right)
    },
    SequenceExpression(node) {
      // `(0, require)("x")` is read as a call; `(0, require)` alone hands the loader on.
      if (!sequenceCallees.has(node.start)) {
        for (const expression of node.expressions) {
          requireValue(expression)
        }
      }
    },
    SpreadElement(node) {
      requireValue(node.argument)
    },
    ExportDefaultDeclaration(node) {
      requireValue(node.declaration)
    },
    TSAsExpression(node) {
      requireValue(node.expression)
    },
    TSSatisfiesExpression(node) {
      requireValue(node.expression)
    },
    TSNonNullExpression(node) {
      requireValue(node.expression)
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

  // `const load = require`, `[require].map(...)`: a require passed around loads modules the check cannot follow.
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
