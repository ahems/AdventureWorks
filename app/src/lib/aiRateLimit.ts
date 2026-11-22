/**
 * The anonymous AI routes (Help Me Choose, semantic search and suggestions) return
 * HTTP 429 with a Retry-After header when a per-client or daily budget is exhausted.
 */
export class AiRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null) {
    super("AI request rate limit reached");
    this.name = "AiRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const isAiRateLimitError = (error: unknown): error is AiRateLimitError =>
  error instanceof AiRateLimitError ||
  (error instanceof Error && error.name === "AiRateLimitError");

export const throwIfAiRateLimited = (response: Response): void => {
  if (response.status !== 429) return;
  const header = response.headers.get("Retry-After");
  const seconds = header ? Number.parseInt(header, 10) : Number.NaN;
  throw new AiRateLimitError(
    Number.isFinite(seconds) && seconds > 0 ? seconds : null,
  );
};

/** Minutes to show the shopper, rounded up and at least 1. */
export const retryAfterMinutes = (error: AiRateLimitError): number =>
  Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60));

/** React Query retry predicate: never retry a rate-limited request. */
export const retryUnlessRateLimited =
  (maxRetries: number) => (failureCount: number, error: unknown) =>
    !isAiRateLimitError(error) && failureCount < maxRetries;
