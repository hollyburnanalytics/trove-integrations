import { type ToolContext, ToolError } from '@ontrove/mcp';

/** Options for {@link getJson}. */
export interface GetJsonOptions {
  /** Human service name used in the default error messages (e.g. "OpenAlex"). */
  service: string;
  /** Extra request headers, merged over `accept: application/json`. */
  headers?: Record<string, string>;
  /** Friendly message for a 404 (otherwise the generic status message is used). */
  notFound?: string;
  /** Override the non-2xx → ToolError mapping entirely (for bespoke error bodies). */
  errorMap?: (res: Response, body: string) => ToolError | undefined;
}

/** 429 and 5xx are transient; other non-2xx are caller errors. */
const isTransient = (status: number): boolean => status === 429 || status >= 500;

/**
 * Fetch a JSON object from a public API through `ctx.fetchJson`, with a
 * consistent error envelope: non-2xx → ToolError (retryable on 429/5xx), and a
 * guard that rejects a non-object body. The shared shape behind most read-only
 * servers; pass `errorMap` for APIs that need bespoke error parsing.
 */
export async function getJson(
  url: string,
  ctx: Pick<ToolContext, 'fetchJson'>,
  options: GetJsonOptions,
): Promise<Record<string, unknown>> {
  const { service, headers, notFound, errorMap } = options;
  const parsed = await ctx.fetchJson(url, {
    init: { headers: { accept: 'application/json', ...headers } },
    errorMap:
      errorMap ??
      ((res, body) =>
        new ToolError(
          res.status === 404 && notFound
            ? notFound
            : `${service} returned ${res.status}: ${body.slice(0, 100)}`,
          { retryable: isTransient(res.status) },
        )),
  });
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ToolError(`${service} returned malformed data; try again shortly.`, {
      retryable: true,
    });
  }
  return parsed as Record<string, unknown>;
}
