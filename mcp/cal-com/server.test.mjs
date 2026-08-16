import { describe, expect, it } from 'vitest';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import server from './server.ts';

const KEY = 'cal_test_123';

const EVENT_TYPES = {
  status: 'success',
  data: [
    {
      id: 101,
      title: 'Intro call',
      slug: 'intro',
      lengthInMinutes: 30,
      description: 'A quick chat',
      hidden: false,
      bookingUrl: 'https://cal.com/example/intro',
    },
    { id: 102, title: 'Deep dive', slug: 'deep-dive', lengthInMinutes: 60, hidden: true },
  ],
};

const SLOTS = {
  status: 'success',
  data: {
    '2026-07-24': [{ start: '2026-07-24T17:00:00.000Z' }, { start: '2026-07-24T18:00:00.000Z' }],
    '2026-07-25': [{ start: '2026-07-25T16:00:00.000Z' }],
  },
};

const BOOKINGS = {
  status: 'success',
  data: [
    {
      id: 1,
      uid: 'bk_abc',
      title: 'Intro call between Matt and Dana',
      start: '2026-07-24T17:00:00.000Z',
      end: '2026-07-24T17:30:00.000Z',
      status: 'accepted',
      eventTypeId: 101,
      attendees: [{ name: 'Dana', email: 'dana@example.com', timeZone: 'America/Vancouver' }],
    },
  ],
  pagination: { nextCursor: 'cur_2', hasMore: true },
};

/** Assert the Bearer key and the per-endpoint cal-api-version. */
function expectHeaders(init, version) {
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
  expect(headers.get('cal-api-version')).toBe(version);
}

describe('cal-com MCP server', () => {
  it('exposes the five tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'cancel_booking',
      'create_booking',
      'get_available_slots',
      'list_bookings',
      'list_event_types',
    ]);
  });

  it('marks only the two write tools as mutating', () => {
    const mutating = server.tools
      .filter((t) => t.annotations?.readOnlyHint === false)
      .map((t) => t.name)
      .toSorted();
    expect(mutating).toEqual(['cancel_booking', 'create_booking']);
  });

  describe('list_event_types', () => {
    it('lists event types with the 2024-06-14 version', async () => {
      const result = await callTool(
        server,
        'list_event_types',
        {},
        withSecret(KEY, (url, init) => {
          expect(url).toBe('https://api.cal.com/v2/event-types');
          expectHeaders(init, '2024-06-14');
          return { json: EVENT_TYPES };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.eventTypes[0]).toMatchObject({ id: 101, slug: 'intro' });
      expect(result.result.text).toContain('id 101');
      expect(result.result.text).toContain('[hidden]');
    });

    it('passes a username filter through', async () => {
      const result = await callTool(
        server,
        'list_event_types',
        { username: 'matthelm' },
        withSecret(KEY, (url) => {
          expect(url).toContain('username=matthelm');
          return { json: { status: 'success', data: [] } };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.text).toBe('No event types found on this account.');
    });
  });

  describe('get_available_slots', () => {
    it('groups slots by date and uses the 2024-09-04 version', async () => {
      const result = await callTool(
        server,
        'get_available_slots',
        {
          event_type_id: 101,
          start: '2026-07-24T00:00:00Z',
          end: '2026-07-26T00:00:00Z',
          time_zone: 'America/Vancouver',
        },
        withSecret(KEY, (url, init) => {
          expect(url).toContain('eventTypeId=101');
          expect(url).toContain('timeZone=America%2FVancouver');
          expectHeaders(init, '2024-09-04');
          return { json: SLOTS };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.totalSlots).toBe(3);
      expect(result.result.structured.days).toHaveLength(2);
      expect(result.result.structured.days[0].slots[0]).toBe('2026-07-24T17:00:00.000Z');
      expect(result.result.text).toContain('America/Vancouver');
    });

    it('accepts slug + username instead of an id', async () => {
      const result = await callTool(
        server,
        'get_available_slots',
        {
          event_type_slug: 'intro',
          username: 'matthelm',
          start: '2026-07-24',
          end: '2026-07-25',
        },
        withSecret(KEY, (url) => {
          expect(url).toContain('eventTypeSlug=intro');
          expect(url).toContain('username=matthelm');
          return { json: { status: 'success', data: {} } };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.text).toBe('No open slots in that window.');
    });

    it('refuses a half-specified event type without calling out', async () => {
      const result = await callTool(server, 'get_available_slots', {
        event_type_slug: 'intro',
        start: '2026-07-24',
        end: '2026-07-25',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/event_type_id/);
    });
  });

  describe('list_bookings', () => {
    it('lists bookings with filters and surfaces the cursor', async () => {
      const result = await callTool(
        server,
        'list_bookings',
        { status: 'upcoming', limit: 5 },
        withSecret(KEY, (url, init) => {
          expect(url).toContain('status=upcoming');
          expect(url).toContain('limit=5');
          expectHeaders(init, '2026-05-01');
          return { json: BOOKINGS };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.bookings[0].uid).toBe('bk_abc');
      expect(result.result.structured.nextCursor).toBe('cur_2');
      expect(result.result.structured.hasMore).toBe(true);
      expect(result.result.text).toContain('uid: bk_abc');
      expect(result.result.text).toContain('with Dana');
    });

    it('defaults to a limit of 20', async () => {
      const result = await callTool(
        server,
        'list_bookings',
        {},
        withSecret(KEY, (url) => {
          expect(url).toContain('limit=20');
          return { json: { status: 'success', data: [] } };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.hasMore).toBe(false);
    });

    it('rejects a limit above 100', async () => {
      const result = await callTool(server, 'list_bookings', { limit: 500 });
      expect(result.ok).toBe(false);
    });
  });

  describe('create_booking', () => {
    it('posts the documented body and returns the uid', async () => {
      const result = await callTool(
        server,
        'create_booking',
        {
          start: '2026-07-24T17:00:00Z',
          attendee_name: 'Dana Scully',
          attendee_time_zone: 'America/Vancouver',
          attendee_email: 'dana@example.com',
          event_type_id: 101,
        },
        withSecret(KEY, (url, init) => {
          expect(url).toBe('https://api.cal.com/v2/bookings');
          expect(init.method).toBe('POST');
          expectHeaders(init, '2026-02-25');
          const body = JSON.parse(init.body);
          expect(body.eventTypeId).toBe(101);
          // Normalised to the canonical UTC form on the way out.
          expect(body.start).toBe('2026-07-24T17:00:00.000Z');
          expect(body.attendee).toEqual({
            name: 'Dana Scully',
            timeZone: 'America/Vancouver',
            email: 'dana@example.com',
          });
          return {
            status: 201,
            json: {
              status: 'success',
              data: {
                uid: 'bk_new',
                title: 'Intro call',
                start: '2026-07-24T17:00:00.000Z',
                status: 'accepted',
              },
            },
          };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.uid).toBe('bk_new');
      expect(result.result.text).toContain('bk_new');
    });

    it('sends eventTypeId as a number, not a string', async () => {
      const result = await callTool(
        server,
        'create_booking',
        {
          start: '2026-07-24T17:00:00Z',
          attendee_name: 'Dana',
          attendee_time_zone: 'UTC',
          event_type_id: 101,
        },
        withSecret(KEY, (_url, init) => {
          expect(typeof JSON.parse(init.body).eventTypeId).toBe('number');
          return { json: { status: 'success', data: { uid: 'bk_x' } } };
        }),
      );
      expect(result.ok).toBe(true);
    });

    it('converts a zone-offset slot start to UTC before posting', async () => {
      // The exact shape /slots returns when timeZone=America/Vancouver.
      const result = await callTool(
        server,
        'create_booking',
        {
          start: '2026-07-27T09:30:00.000-07:00',
          attendee_name: 'Dana',
          attendee_time_zone: 'America/Vancouver',
          event_type_id: 101,
        },
        withSecret(KEY, (_url, init) => {
          expect(JSON.parse(init.body).start).toBe('2026-07-27T16:30:00.000Z');
          return { json: { status: 'success', data: { uid: 'bk_tz' } } };
        }),
      );
      expect(result.ok).toBe(true);
    });

    it('leaves an already-UTC start unchanged', async () => {
      const result = await callTool(
        server,
        'create_booking',
        {
          start: '2026-07-27T16:30:00.000Z',
          attendee_name: 'Dana',
          attendee_time_zone: 'UTC',
          event_type_id: 101,
        },
        withSecret(KEY, (_url, init) => {
          expect(JSON.parse(init.body).start).toBe('2026-07-27T16:30:00.000Z');
          return { json: { status: 'success', data: { uid: 'bk_utc' } } };
        }),
      );
      expect(result.ok).toBe(true);
    });

    it('rejects an unparseable start without calling out', async () => {
      const result = await callTool(server, 'create_booking', {
        start: 'next tuesday',
        attendee_name: 'Dana',
        attendee_time_zone: 'UTC',
        event_type_id: 101,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a valid ISO 8601/);
    });

    it('surfaces a business-rule rejection sent with HTTP 200', async () => {
      const result = await callTool(
        server,
        'create_booking',
        {
          start: '2026-07-24T17:00:00Z',
          attendee_name: 'Dana',
          attendee_time_zone: 'UTC',
          event_type_id: 101,
        },
        withSecret(KEY, {
          json: { status: 'error', error: { message: 'no_available_users_found' } },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no_available_users_found/);
    });

    it('unwraps a recurring booking returned as an array', async () => {
      const result = await callTool(
        server,
        'create_booking',
        {
          start: '2026-07-24T17:00:00Z',
          attendee_name: 'Dana',
          attendee_time_zone: 'UTC',
          event_type_id: 101,
        },
        withSecret(KEY, {
          json: { status: 'success', data: [{ uid: 'bk_r1' }, { uid: 'bk_r2' }] },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.uid).toBe('bk_r1');
    });
  });

  describe('cancel_booking', () => {
    it('posts to the cancel path with the reason', async () => {
      const result = await callTool(
        server,
        'cancel_booking',
        { booking_uid: 'bk_abc', reason: 'Conflict came up' },
        withSecret(KEY, (url, init) => {
          expect(url).toBe('https://api.cal.com/v2/bookings/bk_abc/cancel');
          expect(init.method).toBe('POST');
          expectHeaders(init, '2026-02-25');
          expect(JSON.parse(init.body)).toEqual({ cancellationReason: 'Conflict came up' });
          return {
            json: {
              status: 'success',
              data: { uid: 'bk_abc', title: 'Intro call', status: 'cancelled' },
            },
          };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.status).toBe('cancelled');
      expect(result.result.text).toContain('bk_abc');
    });

    it('url-encodes the uid rather than injecting it into the path', async () => {
      const result = await callTool(
        server,
        'cancel_booking',
        { booking_uid: 'a/../b' },
        withSecret(KEY, (url) => {
          expect(url).toBe('https://api.cal.com/v2/bookings/a%2F..%2Fb/cancel');
          return { json: { status: 'success', data: {} } };
        }),
      );
      expect(result.ok).toBe(true);
    });

    it('reports a missing booking as not found', async () => {
      const result = await callTool(
        server,
        'cancel_booking',
        { booking_uid: 'nope' },
        withSecret(KEY, { status: 404, text: 'not found' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/404/);
    });
  });

  describe('error mapping', () => {
    it('treats a rate limit as retryable', async () => {
      const result = await callTool(
        server,
        'list_bookings',
        {},
        withSecret(KEY, { status: 429, text: 'too many' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/rate limit/i);
    });

    it('does not retry a rejected API key', async () => {
      const result = await callTool(
        server,
        'list_event_types',
        {},
        withSecret(KEY, { status: 401, text: 'unauthorized' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/CALCOM_API_KEY/);
    });

    it('retries a server error', async () => {
      const result = await callTool(
        server,
        'list_bookings',
        {},
        withSecret(KEY, { status: 503, text: 'down' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('never leaks the API key into an error message', async () => {
      const result = await callTool(
        server,
        'list_bookings',
        {},
        withSecret(KEY, { status: 500, text: 'boom' }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain(KEY);
    });
  });
});
