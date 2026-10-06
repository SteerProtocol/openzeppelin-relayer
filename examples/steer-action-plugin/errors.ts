export class ActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = "ActionError";
  }
}
// Only positively identified execution failures may become failed gas probes.
// Transport errors and unknown provider failures must abort the search.
export class ExecutionReverted extends ActionError {
  constructor() {
    super("EXECUTION_REVERTED", "RPC execution reverted or ran out of gas");
  }
}
export function isExecutionFailure(error: {
  code?: number;
  message?: string;
}): boolean {
  return (
    (error.code === 3 || error.code === -32000 || error.code === -32015) &&
    /execution reverted|out of gas|intrinsic gas too low|gas required exceeds allowance/i.test(
      error.message ?? "",
    )
  );
}

export async function withinDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new ActionError(
      "DEADLINE_EXCEEDED",
      "Action validation deadline exceeded",
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ActionError(
                "DEADLINE_EXCEEDED",
                "Action validation deadline exceeded",
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
