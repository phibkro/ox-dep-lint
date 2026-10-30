/** The outcome of an operation that can fail, as a value: the caller handles the failure as data, not as an exception. */
export type Result<Value, Failure> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: Failure }

export const success = <Value>(value: Value): Result<Value, never> => ({ ok: true, value })

export const failure = <Failure>(error: Failure): Result<never, Failure> => ({ ok: false, error })

/** Runs `operation`, with what it throws as the failure. */
export const attempt = <Value>(operation: () => Value): Result<Value, unknown> => {
  try {
    return success(operation())
  } catch (cause) {
    return failure(cause)
  }
}

/** The message of something thrown, which need not be an Error. */
export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * Whether something thrown by `node:fs` says the path is no longer there: `ENOENT`, or `ENOTDIR` when a directory on the
 * way was replaced by a file. A path removed between being listed and being read (a test's temporary tree, an editor's
 * swap file) fails this way, and is skipped rather than reported as unreadable.
 */
export const vanished = (cause: unknown): boolean => {
  const code = codeOf(cause)

  return code === "ENOENT" || code === "ENOTDIR"
}

/** The error code of something thrown by `node:fs` (`EACCES`), or its message when it has none. */
export const codeOf = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : messageOf(cause)
