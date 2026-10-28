export type AppErrorCode = "validation" | "forbidden" | "not_found" | "conflict" | "dependency" | "unauthenticated";

/** Expected, user-facing failure. Message is safe to show in the UI. */
export class AppError extends Error {
  constructor(
    public code: AppErrorCode,
    message: string,
    public fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
