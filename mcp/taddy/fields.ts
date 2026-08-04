import { z } from '@ontrove/mcp';

/** Zod field helpers shared by the tool modules under `tools/`. */

/**
 * Taddy's ids are standard 36-character UUIDs.
 *
 * Validating the shape here rather than letting the API decide is worth a rule
 * of its own: an id-shaped mistake (a slug, a truncated id, an iTunes number)
 * would otherwise cost one of the account's 500 monthly requests to learn.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A required Taddy uuid argument. */
export function uuidField(description: string): z.ZodString {
  return z.string().regex(UUID).describe(description);
}
