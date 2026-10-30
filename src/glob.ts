/**
 * The glob dialect of the configuration: `**` (as a whole segment) is zero or more directories, `*` and `?` stay inside
 * one segment, `{a,b}` is either. Paths and patterns use `/`. Adapted from the store boundary check of
 * phibkro/vektorprogrammet-reimagined (same author), whose semantics it keeps.
 */

const special = /[.+^$()|[\]\\]/gu

const segmentSource = (segment: string): string => {
  let source = ""
  let index = 0

  while (index < segment.length) {
    const character = segment.charAt(index)

    if (character === "*") {
      source += "[^/]*"
    } else if (character === "?") {
      source += "[^/]"
    } else if (character === "{") {
      const close = segment.indexOf("}", index)

      if (close === -1) {
        source += "\\{"
      } else {
        const choices = segment.slice(index + 1, close).split(",")
        source += `(?:${choices.map((choice) => segmentSource(choice)).join("|")})`
        index = close
      }
    } else {
      source += character.replaceAll(special, String.raw`\$&`)
    }

    index += 1
  }

  return source
}

const cache = new Map<string, RegExp>()

/** The regular expression a glob compiles to, anchored at both ends. */
export const globExpression = (pattern: string): RegExp => {
  const cached = cache.get(pattern)

  if (cached !== undefined) {
    return cached
  }

  const segments = pattern.split("/")
  let source = ""

  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1

    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*"
    } else {
      source += segmentSource(segment) + (last ? "" : "/")
    }
  }

  const expression = new RegExp(`^${source}$`, "u")
  cache.set(pattern, expression)

  return expression
}

/** Whether `path` matches `pattern`. */
export const matchesGlob = (path: string, pattern: string): boolean => globExpression(pattern).test(path)

/** Whether `path` matches any of `patterns`. */
export const matchesAny = (path: string, patterns: readonly string[]): boolean => patterns.some((pattern) => matchesGlob(path, pattern))
