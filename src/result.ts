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

/** The error code of something thrown by `node:fs` (`EACCES`), or its message when it has none. */
export const codeOf = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : messageOf(cause)
