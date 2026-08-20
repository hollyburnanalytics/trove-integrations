import { defineToolkit, tool, z } from '@ontrove/extend/toolkit';
import {
  apiKey,
  BOOKING_STATUS,
  type Booking,
  bookingBody,
  bookingLine,
  bookingQuery,
  calJson,
  type EventType,
  eventTypeSelector,
  type SlotMap,
  VERSION,
} from './client.ts';

/**
 * Cal.com scheduling MCP server, hosted on Trove — read the caller's event
 * types, open slots and bookings, and (with host confirmation) create or cancel
 * a booking.
 *
 * Auth is a Cal.com API key (`cal_…`) sent as a Bearer token, resolved
 * per-invocation via `ctx.requireSecret`; the only egress is api.cal.com.
 * Transport, the per-endpoint `cal-api-version` map and the shared response
 * shapes all live in `client.ts`.
 *
 * `create_booking` and `cancel_booking` are `readOnlyHint: false`: they create a
 * real calendar event and notify a real attendee, so the host confirms first.
 * Nothing is pinned to a secret the way `resend` pins its recipient — an
 * arbitrary attendee *is* the legitimate use of a booking tool — so the
 * confirmation step, plus per-uid (never bulk) cancellation, is the control.
 */

export default defineToolkit({
  tools: [
    tool({
      name: 'list_event_types',
      title: 'Cal.com: List event types',
      description:
        'List the bookable event types (meeting types) on the authenticated Cal.com account — their ids, slugs, durations and booking URLs. Start here to get the event_type_id the other tools need.',
      input: z.object({
        username: z
          .string()
          .optional()
          .describe(
            'Only list event types for this Cal.com username (defaults to the API key owner).',
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler({ username }, ctx) {
        const key = await apiKey(ctx);
        const params = new URLSearchParams();
        if (username) params.set('username', username);
        const query = params.size > 0 ? `?${params}` : '';
        const { data } = await calJson(
          { path: `/event-types${query}`, version: VERSION.eventTypes, what: 'list event types' },
          ctx,
          key,
        );
        const types = ((data ?? []) as EventType[]).map((t) => ({
          id: t.id,
          title: t.title,
          slug: t.slug,
          lengthInMinutes: t.lengthInMinutes,
          description: t.description,
          hidden: t.hidden,
          bookingUrl: t.bookingUrl,
        }));
        const lines = types.map(
          (t) =>
            `• ${t.title} (id ${t.id}, slug "${t.slug}")${
              t.lengthInMinutes ? ` — ${t.lengthInMinutes} min` : ''
            }${t.hidden ? ' [hidden]' : ''}`,
        );
        return {
          text: types.length
            ? `${types.length} event type(s):\n${lines.join('\n')}`
            : 'No event types found on this account.',
          structured: { count: types.length, eventTypes: types },
        };
      },
    }),
    tool({
      name: 'get_available_slots',
      title: 'Cal.com: Get available slots',
      description:
        'Find open booking slots for an event type between two instants. Returns slot start times grouped by date. Use this before create_booking so the chosen start is actually free.',
      input: z.object({
        event_type_id: z
          .number()
          .int()
          .optional()
          .describe('Event type id (from list_event_types).'),
        event_type_slug: z
          .string()
          .optional()
          .describe('Event type slug — requires username. Alternative to event_type_id.'),
        username: z.string().optional().describe('Cal.com username, when using event_type_slug.'),
        start: z
          .string()
          .describe('Start of the window, ISO 8601 UTC (e.g. 2026-07-24T00:00:00Z) or YYYY-MM-DD.'),
        end: z
          .string()
          .describe('End of the window, ISO 8601 UTC (e.g. 2026-07-31T00:00:00Z) or YYYY-MM-DD.'),
        time_zone: z
          .string()
          .optional()
          .describe(
            'IANA time zone for the returned slots, e.g. America/Vancouver. Defaults to UTC.',
          ),
        duration: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Slot length in minutes, for event types offering multiple durations.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(
        { event_type_id, event_type_slug, username, start, end, time_zone, duration },
        ctx,
      ) {
        // Validate the selector before redeeming the secret — a malformed call
        // should fail without a vault round-trip.
        const selector = eventTypeSelector(event_type_id, event_type_slug, username);
        const key = await apiKey(ctx);
        const params = new URLSearchParams({ ...selector, start, end });
        if (time_zone) params.set('timeZone', time_zone);
        if (duration !== undefined) params.set('duration', String(duration));
        const { data } = await calJson(
          { path: `/slots?${params}`, version: VERSION.slots, what: 'get available slots' },
          ctx,
          key,
        );
        const byDate = (data ?? {}) as SlotMap;
        const days = Object.entries(byDate).map(([date, slots]) => ({
          date,
          slots: (slots ?? []).map((s) => s.start).filter((s): s is string => Boolean(s)),
        }));
        const total = days.reduce((n, d) => n + d.slots.length, 0);
        const lines = days
          .slice(0, 14)
          .map(
            (d) =>
              `• ${d.date}: ${d.slots.length} slot(s)${d.slots[0] ? ` from ${d.slots[0]}` : ''}`,
          );
        return {
          text: total
            ? `${total} open slot(s) across ${days.length} day(s)${
                time_zone ? ` (${time_zone})` : ' (UTC)'
              }:\n${lines.join('\n')}`
            : 'No open slots in that window.',
          structured: { totalSlots: total, timeZone: time_zone ?? 'UTC', days },
        };
      },
    }),
    tool({
      name: 'list_bookings',
      title: 'Cal.com: List bookings',
      description:
        'List bookings on the authenticated account, newest window first. Filter by status (upcoming, past, cancelled…), date range, event type, attendee, or a specific booking uid. The uid is what cancel_booking needs.',
      input: z.object({
        status: z
          .enum(BOOKING_STATUS)
          .optional()
          .describe('Filter to one status. Omit for all statuses.'),
        booking_uid: z.string().optional().describe('Look up one specific booking by its uid.'),
        event_type_id: z.number().int().optional().describe('Only bookings for this event type.'),
        attendee_email: z.string().optional().describe("Filter by an attendee's email address."),
        after_start: z
          .string()
          .optional()
          .describe('Only bookings starting after this ISO 8601 instant.'),
        before_end: z
          .string()
          .optional()
          .describe('Only bookings ending before this ISO 8601 instant.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Maximum bookings to return (1-100, default 20).'),
        cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(filters, ctx) {
        const key = await apiKey(ctx);
        const params = bookingQuery(filters);
        const { data, pagination } = await calJson(
          { path: `/bookings?${params}`, version: VERSION.bookingsRead, what: 'list bookings' },
          ctx,
          key,
        );
        const bookings = ((data ?? []) as Booking[]).map((b) => ({
          uid: b.uid,
          id: b.id,
          title: b.title,
          start: b.start,
          end: b.end,
          status: b.status,
          eventTypeId: b.eventTypeId,
          meetingUrl: b.meetingUrl,
          attendees: (b.attendees ?? []).map((a) => ({
            name: a.name,
            email: a.email,
            timeZone: a.timeZone,
          })),
        }));
        return {
          text: bookings.length
            ? `${bookings.length} booking(s)${filters.status ? ` (${filters.status})` : ''}:\n${bookings
                .map((b) => bookingLine(b))
                .join('\n')}${pagination?.hasMore ? '\n(more available — pass the cursor)' : ''}`
            : `No bookings found${filters.status ? ` with status "${filters.status}"` : ''}.`,
          structured: {
            count: bookings.length,
            bookings,
            nextCursor: pagination?.nextCursor ?? undefined,
            hasMore: pagination?.hasMore ?? false,
          },
        };
      },
    }),
    tool({
      name: 'create_booking',
      title: 'Cal.com: Create a booking',
      description:
        'Book a slot on the authenticated Cal.com account. Confirm the start time is free with get_available_slots first — Cal.com rejects an unavailable slot. This creates a real calendar event and emails the attendee.',
      input: z.object({
        start: z
          .string()
          .describe(
            'Slot start, ISO 8601 UTC (e.g. 2026-07-24T17:00:00Z). Must match an open slot.',
          ),
        attendee_name: z.string().min(1).describe("The attendee's full name."),
        attendee_time_zone: z
          .string()
          .describe("The attendee's IANA time zone, e.g. America/Vancouver."),
        attendee_email: z
          .string()
          .optional()
          .describe("The attendee's email — needed for them to get the confirmation."),
        event_type_id: z
          .number()
          .int()
          .optional()
          .describe('Event type id (from list_event_types).'),
        event_type_slug: z
          .string()
          .optional()
          .describe('Event type slug — requires username. Alternative to event_type_id.'),
        username: z.string().optional().describe('Cal.com username, when using event_type_slug.'),
        guests: z
          .array(z.string())
          .optional()
          .describe('Additional guest email addresses to invite.'),
        length_in_minutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Booking length, for event types offering multiple durations.'),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
      async handler(input, ctx) {
        // Built before the secret is redeemed: a bad event-type selector or an
        // unparseable start should fail without a vault round-trip or a request.
        const body = bookingBody(input);
        const startUtc = body.start as string;
        const key = await apiKey(ctx);
        const { data } = await calJson(
          {
            path: '/bookings',
            version: VERSION.bookingsWrite,
            what: 'create the booking',
            method: 'POST',
            body,
          },
          ctx,
          key,
        );
        const booking = (Array.isArray(data) ? data[0] : data) as Booking | undefined;
        return {
          text: booking
            ? `Booked "${booking.title ?? 'meeting'}" for ${booking.start ?? startUtc}${
                booking.status ? ` [${booking.status}]` : ''
              }. Booking uid: ${booking.uid ?? '(none returned)'}`
            : `Booking request accepted for ${startUtc}, but Cal.com returned no booking payload.`,
          structured: {
            uid: booking?.uid,
            id: booking?.id,
            title: booking?.title,
            start: booking?.start,
            end: booking?.end,
            status: booking?.status,
            meetingUrl: booking?.meetingUrl,
          },
        };
      },
    }),
    tool({
      name: 'cancel_booking',
      title: 'Cal.com: Cancel a booking',
      description:
        'Cancel one booking by its uid (get it from list_bookings). This notifies the attendee and frees the slot. Cancels exactly the booking named — there is no bulk cancel.',
      input: z.object({
        booking_uid: z.string().min(1).describe('The uid of the booking to cancel.'),
        reason: z
          .string()
          .optional()
          .describe('Cancellation reason, shown to the attendee in the notification.'),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
      async handler({ booking_uid, reason }, ctx) {
        const key = await apiKey(ctx);
        const { data } = await calJson(
          {
            path: `/bookings/${encodeURIComponent(booking_uid)}/cancel`,
            version: VERSION.bookingsWrite,
            what: 'cancel the booking',
            method: 'POST',
            body: reason ? { cancellationReason: reason } : {},
          },
          ctx,
          key,
        );
        const booking = (Array.isArray(data) ? data[0] : data) as Booking | undefined;
        return {
          text: `Cancelled booking ${booking_uid}${
            booking?.title ? ` ("${booking.title}")` : ''
          }${booking?.status ? ` — status now ${booking.status}` : ''}.`,
          structured: {
            uid: booking?.uid ?? booking_uid,
            title: booking?.title,
            status: booking?.status,
            cancellationReason: booking?.cancellationReason ?? reason,
          },
        };
      },
    }),
  ],
});
