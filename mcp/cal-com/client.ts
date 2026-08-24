import type { ToolContext } from '@ontrove/extend/toolkit';
import { ToolError } from '@ontrove/extend/toolkit';

/**
 * Transport and shared shapes for the Cal.com v2 API — everything the tool
 * handlers in `extension.ts` need to talk to api.cal.com, kept here so each handler
 * stays about its own tool.
 */

const CAL = 'https://api.cal.com/v2';

/**
 * Per-endpoint-group `cal-api-version` values, from the v2 reference. These are
 * not interchangeable: reading and writing bookings are pinned to *different*
 * versions upstream, and sending the wrong one silently serves an older contract
 * with a different response shape rather than erroring.
 */
export const VERSION = {
  eventTypes: '2024-06-14',
  slots: '2024-09-04',
  bookingsRead: '2026-05-01',
  bookingsWrite: '2026-02-25',
} as const;

/** Booking statuses the list endpoint accepts as a filter. */
export const BOOKING_STATUS = [
  'upcoming',
  'recurring',
  'past',
  'cancelled',
  'unconfirmed',
] as const;

export interface EventType {
  id: number;
  title: string;
  slug: string;
  lengthInMinutes?: number;
  description?: string;
  hidden?: boolean;
  bookingUrl?: string;
}

export interface Attendee {
  name?: string;
  email?: string;
  timeZone?: string;
}

export interface Booking {
  id?: number;
  uid?: string;
  title?: string;
  start?: string;
  end?: string;
  status?: string;
  attendees?: Attendee[];
  eventTypeId?: number;
  meetingUrl?: string;
  cancellationReason?: string;
}

/** `{ "2026-07-24": [{ start, end? }] }` — the slots endpoint's date-keyed map. */
export type SlotMap = Record<string, { start?: string; end?: string }[]>;

/** The `{ status, data }` envelope every v2 endpoint wraps its payload in. */
interface CalEnvelope {
  status?: string;
  data?: unknown;
  error?: unknown;
  pagination?: { nextCursor?: string | null; hasMore?: boolean };
}

export interface CalRequest {
  /** Endpoint path below `/v2`, including any query string. */
  path: string;
  /** The `cal-api-version` this endpoint group requires — see {@link VERSION}. */
  version: string;
  /** Human phrase for error messages, e.g. "list bookings". */
  what: string;
  /** Defaults to GET. */
  method?: 'GET' | 'POST';
  /** JSON request body, for POSTs. */
  body?: unknown;
}

/** Map a non-2xx Cal.com response to a model-safe ToolError. */
function calError(what: string, response: Response, body: string): ToolError {
  if (response.status === 429) {
    return new ToolError(
      'Cal.com rate limit reached (about 120 requests/minute). Wait a moment and try again.',
      { retryable: true },
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new ToolError(
      `Cal.com rejected the API key (HTTP ${response.status}). Check the CALCOM_API_KEY secret.`,
      { retryable: false },
    );
  }
  if (response.status === 404) {
    return new ToolError(`Could not ${what} — Cal.com returned 404 (not found).`, {
      retryable: false,
    });
  }
  return new ToolError(`Failed to ${what} (HTTP ${response.status}): ${body.slice(0, 160)}`, {
    retryable: response.status >= 500,
  });
}

/**
 * Call a Cal.com v2 endpoint and unwrap the `{ status, data }` envelope.
 *
 * A 2xx carrying `status: "error"` is treated as a failure — Cal.com uses it for
 * business-rule rejections (an unavailable slot, a booking already cancelled),
 * which would otherwise read as an empty success.
 */
export async function calJson(
  request: CalRequest,
  ctx: Pick<ToolContext, 'fetchJson'>,
  key: string,
): Promise<{ data: unknown; pagination?: CalEnvelope['pagination'] }> {
  const { path, version, what, method = 'GET', body } = request;
  const envelope = (await ctx.fetchJson(`${CAL}${path}`, {
    init: {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        'cal-api-version': version,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    errorMap: (response, text) => calError(what, response, text),
  })) as CalEnvelope | undefined;

  if (envelope?.status === 'error') {
    const detail =
      typeof envelope.error === 'object' && envelope.error !== null
        ? JSON.stringify(envelope.error).slice(0, 160)
        : String(envelope.error ?? 'no detail given');
    throw new ToolError(`Cal.com could not ${what}: ${detail}`, { retryable: false });
  }
  return { data: envelope?.data, pagination: envelope?.pagination };
}

/** Resolve the CALCOM_API_KEY secret. */
export async function apiKey(ctx: ToolContext): Promise<string> {
  return ctx.requireSecret('CALCOM_API_KEY');
}

/** One-line label for a booking, used in the text summaries. */
export function bookingLine(b: Booking): string {
  const who = (b.attendees ?? [])
    .map((a) => a.name || a.email)
    .filter(Boolean)
    .join(', ');
  const when = b.start ? b.start.replace('.000Z', 'Z') : 'unscheduled';
  const attendees = who ? ` with ${who}` : '';
  const status = b.status ? ` [${b.status}]` : '';
  const uid = b.uid ? ` (uid: ${b.uid})` : '';
  return `• ${b.title ?? '(untitled)'} — ${when}${attendees}${status}${uid}`;
}

/**
 * Identify an event type either by numeric id or by slug + username, the two
 * forms Cal.com accepts. Returns the query/body fragment, or throws when the
 * caller supplied neither (or half of the slug pair).
 */
export function eventTypeSelector(
  eventTypeId: number | undefined,
  eventTypeSlug: string | undefined,
  username: string | undefined,
): Record<string, string> {
  if (eventTypeId !== undefined) return { eventTypeId: String(eventTypeId) };
  if (eventTypeSlug && username) return { eventTypeSlug, username };
  throw new ToolError(
    'Identify the event type: pass event_type_id, or both event_type_slug and username. Use list_event_types to find them.',
    { retryable: false },
  );
}

/**
 * Normalise an ISO 8601 instant to UTC (`…Z`), which is what the booking
 * endpoints require.
 *
 * This matters because `/slots` returns starts carrying the *requested* zone's
 * offset — `2026-07-27T09:30:00.000-07:00`, not `…Z` — so feeding a slot start
 * straight back into `create_booking` would hand Cal.com a non-UTC string for a
 * field its reference documents as UTC. Converting here makes the natural
 * slots → booking round-trip correct regardless of the zone the slots were
 * requested in. An offset-bearing instant is unambiguous, so this is a lossless
 * reformat, not a guess.
 */
export function toUtcInstant(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ToolError(
      `${field} is not a valid ISO 8601 date-time: "${value}". Use e.g. 2026-07-27T16:30:00Z.`,
      { retryable: false },
    );
  }
  return parsed.toISOString();
}

/** The `create_booking` input surface, in snake_case as the tool receives it. */
export interface BookingInput {
  start: string;
  attendee_name: string;
  attendee_time_zone: string;
  attendee_email?: string;
  event_type_id?: number;
  event_type_slug?: string;
  username?: string;
  guests?: string[];
  length_in_minutes?: number;
}

/**
 * Build the `POST /bookings` body from the tool inputs: resolve the event-type
 * selector, normalise `start` to UTC, and drop every field the caller omitted
 * (Cal.com rejects explicit nulls). Throws before any network call if the event
 * type is under-specified or the start is unparseable.
 */
export function bookingBody(input: BookingInput): Record<string, unknown> {
  const selector = eventTypeSelector(input.event_type_id, input.event_type_slug, input.username);
  return {
    start: toUtcInstant(input.start, 'start'),
    attendee: {
      name: input.attendee_name,
      timeZone: input.attendee_time_zone,
      ...(input.attendee_email && { email: input.attendee_email }),
    },
    ...(selector.eventTypeId ? { eventTypeId: Number(selector.eventTypeId) } : selector),
    ...(input.guests?.length && { guests: input.guests }),
    ...(input.length_in_minutes !== undefined && { lengthInMinutes: input.length_in_minutes }),
  };
}

/** The `list_bookings` filter surface, in snake_case as the tool receives it. */
export interface BookingFilters {
  status?: string;
  booking_uid?: string;
  event_type_id?: number;
  attendee_email?: string;
  after_start?: string;
  before_end?: string;
  limit: number;
  cursor?: string;
}

/**
 * Translate the snake_case tool inputs into Cal.com's camelCase query string.
 * Extracted so the handler stays under the cognitive-complexity ratchet — this
 * is a flat mapping, not logic.
 */
export function bookingQuery(filters: BookingFilters): URLSearchParams {
  const pairs: [string, string | undefined][] = [
    ['limit', String(filters.limit)],
    ['status', filters.status],
    ['bookingUid', filters.booking_uid],
    [
      'eventTypeId',
      filters.event_type_id === undefined ? undefined : String(filters.event_type_id),
    ],
    ['attendeeEmail', filters.attendee_email],
    ['afterStart', filters.after_start],
    ['beforeEnd', filters.before_end],
    ['cursor', filters.cursor],
  ];
  const params = new URLSearchParams();
  for (const [name, value] of pairs) if (value !== undefined) params.set(name, value);
  return params;
}
