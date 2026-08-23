import { describe, expect, it } from 'vitest';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import { authorization, isAccessToken, quotaNote, readQuota, untilReset } from './client.ts';
import server from './extension.ts';
import SEARCH from './fixtures/search.json' with { type: 'json' };
import SEARCH_FILTERED from './fixtures/search-include-filtered.json' with { type: 'json' };
import MINIFIED from './fixtures/search-minified-trips.json' with { type: 'json' };
import TRIPS from './fixtures/trips.json' with { type: 'json' };
import { fmtDuration } from './money.ts';
import {
  airportList,
  carrierList,
  departureWindow,
  homeAirports,
  sameAirportNotes,
  searchQuery,
} from './params.ts';
import { cabinCoverageNotes, PROGRAMS, resolveSources } from './programs.ts';
import { pageFooter, toAvailability, toPage } from './render.ts';
import { summarise } from './tools/get-trips.ts';
import { localTime, toTrip, tripLines } from './trips.ts';

const KEY = 'seats-key-abc123';

/**
 * The availability and trip fixtures are **verbatim captures of live partner API
 * responses** (`mcp/seats-aero/fixtures/*.json`), not hand-written shapes. That
 * matters here more than usual: the reference documents roughly a third of the
 * fields these endpoints actually send, and every decoding rule below was
 * written against what the API really returned for SFO→LHR on 2026-09-01.
 *
 * What the captures cover:
 *  - united — economy where the cheapest routing (40,000 via DEN) is far cheaper
 *    than the cheapest non-stop (65,400), business where no non-stop survives,
 *    premium economy that exists only at dynamic pricing, and co-brand card rates.
 *  - qantas — a program the reference lists as publishing no seat counts, which
 *    published four, plus $349 of surcharges.
 *  - american — a bookable cabin reporting zero seats, and two cabins that exist
 *    only unfiltered.
 */

const LIVE_JSON = `{
  "results": [
    { "ID": "live-1", "RouteID": "", "AvailabilityID": "",
      "AvailabilitySegments": [
        { "ID": "live-seg-1", "FlightNumber": "QF433", "Distance": 439,
          "OriginAirport": "SYD", "DestinationAirport": "MEL",
          "DepartsAt": "2026-09-20T10:00:00Z", "ArrivesAt": "2026-09-20T11:35:00Z",
          "Source": "qantas", "Cabin": "" }
      ],
      "TotalDuration": 270, "Stops": 0, "Carriers": "QF", "RemainingSeats": 0,
      "MileageCost": 18000, "TotalTaxes": 9489, "TaxesCurrency": "AUD",
      "TaxesCurrencySymbol": "$", "FlightNumbers": "QF433",
      "DepartsAt": "2026-09-20T10:00:00Z", "Cabin": "economy",
      "ArrivesAt": "2026-09-20T14:30:00Z", "Source": "qantas", "Filtered": false }
  ],
  "bookingLinks": [
    { "label": "Book via Qantas Frequent Flyer", "link": "https://www.qantas.com", "primary": true }
  ],
  "success": true
}`;

/** Look a mileage program up by slug. */
function by(slug) {
  return PROGRAMS.find((program) => program.source === slug);
}

/** A minimal Trip, for exercising the prose summariser. */
function trip(cabin, mileageCost) {
  return { cabin, mileageCost, segments: [], cardRates: [] };
}

describe('seats-aero MCP server', () => {
  it('lists the five tools', () => {
    expect(server.tools.map((tool) => tool.name).toSorted()).toEqual([
      'explore_availability',
      'get_trips',
      'list_programs',
      'live_search',
      'search_awards',
    ]);
  });

  it('marks every tool read-only', () => {
    for (const tool of server.tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  describe('auth header', () => {
    it('sends a personal Pro API key bare', () => {
      expect(isAccessToken(KEY)).toBe(false);
      expect(authorization(KEY)).toBe(KEY);
    });

    it('prefixes an OAuth2 access token with Bearer', () => {
      expect(isAccessToken('seats:ota:123')).toBe(true);
      expect(authorization('seats:ota:123')).toBe('Bearer seats:ota:123');
    });
  });

  describe('program table', () => {
    it('covers the 26 documented programs with unique slugs', () => {
      expect(PROGRAMS).toHaveLength(26);
      expect(new Set(PROGRAMS.map((program) => program.source)).size).toBe(26);
    });

    it('names an unknown program instead of letting it return an empty page', () => {
      expect(() => resolveSources(['aeroplane'], 'sources')).toThrow(
        /not a Seats\.aero mileage program/,
      );
      expect(() => resolveSources(['aeroplane'], 'sources')).toThrow(/Did you mean aeroplan/);
    });

    it('accepts documented slugs case-insensitively and de-duplicates', () => {
      expect(resolveSources(['Aeroplan', 'aeroplan', 'united'], 'sources')).toEqual([
        'aeroplan',
        'united',
      ]);
    });

    it('notes a cabin a requested program is not documented to cover', () => {
      const notes = cabinCoverageNotes(['eurobonus', 'united'], ['first']);
      expect(notes.join(' ')).toContain('SAS EuroBonus');
      expect(notes.join(' ')).toContain('an empty result may mean that');
    });

    it('notes rather than refuses when no program documents the cabin', () => {
      // Live sampling found Lufthansa selling premium economy the reference
      // table omits, so refusing on this table would block real availability.
      const notes = cabinCoverageNotes(['eurobonus'], ['first']);
      expect(notes.join(' ')).toContain('documentation rather than ground truth');
    });

    it('carries the corrections live sampling forced on the reference table', () => {
      // Five programs the docs list as publishing no seat counts do publish them.
      for (const slug of ['emirates', 'qantas', 'qatar', 'turkish', 'singapore']) {
        expect(by(slug).seatCounts).not.toBe('no');
      }
      // Only these two were observed genuinely silent.
      expect(by('azul').seatCounts).toBe('no');
      expect(by('frontier').seatCounts).toBe('no');
      // Lufthansa sells premium economy; the reference table says Y/J/F.
      expect(by('lufthansa').cabins).toContain('premium');
    });
  });

  describe('input validation', () => {
    it('normalises airport codes to upper case', () => {
      // Not required by the API — `sfo` was verified to work — but it keeps the
      // echoed route in the summary consistent with what the caller reads.
      expect(airportList(['sfo', 'oak'], 'origin_airport')).toBe('SFO,OAK');
    });

    it('flags an airport asked to be both origin and destination', () => {
      // Verified live: SFO→SFO is an empty 200, indistinguishable from no space.
      expect(sameAirportNotes('SFO,LAX', 'LHR')).toEqual([]);
      expect(sameAirportNotes('SFO,LAX', 'SFO,LHR')[0]).toContain('both origin and destination');
    });

    it('does not invent a take floor the API does not enforce', () => {
      // The reference says take must be >= 10; live, take=3 returns 3 records.
      const tool = server.tools.find((entry) => entry.name === 'search_awards');
      expect(tool.inputSchema.properties.take.minimum).toBe(1);
      expect(tool.inputSchema.properties.take.maximum).toBe(1000);
    });

    it('rejects anything that is not a 3-letter airport code', () => {
      expect(() => airportList(['London'], 'origin_airport')).toThrow(/not a 3-letter IATA/);
      expect(() => airportList(['London'], 'origin_airport')).toThrow(/not by city or country/);
    });

    it('rejects a bad carrier code', () => {
      expect(carrierList(['dl', 'aa'])).toBe('DL,AA');
      expect(() => carrierList(['Delta'])).toThrow(/2-character IATA airline code/);
    });

    it('refuses a reversed date range rather than passing it on', () => {
      expect(() => departureWindow('2026-09-30', '2026-09-01', new Date())).toThrow(
        /is after end_date/,
      );
    });

    it('flags a window that has already passed', () => {
      const window = departureWindow('2024-01-01', '2024-01-31', new Date('2026-07-31T00:00:00Z'));
      expect(window.notes[0]).toContain('in the past everywhere on Earth');
      expect(window.notes[0]).toContain('not "no award space"');
    });

    it('allows a day of slack, so no time zone can make the past-window note wrong', () => {
      // 17:00 in Vancouver on the 30th is already the 31st in UTC. A window
      // ending "today" for the caller must not be called historical.
      const utcNow = new Date('2026-07-31T00:00:00Z');
      expect(departureWindow(undefined, '2026-07-30', utcNow).notes).toEqual([]);
      expect(departureWindow(undefined, '2026-07-29', utcNow).notes).toHaveLength(1);
    });

    it('says when minify_trips was ignored', () => {
      const { notes } = searchQuery(
        {
          origin_airport: ['SFO'],
          destination_airport: ['LHR'],
          only_direct_flights: false,
          include_trips: false,
          minify_trips: true,
          include_filtered: false,
          take: 100,
          skip: 0,
        },
        new Date(),
      );
      expect(notes.join(' ')).toContain('minify_trips was ignored');
    });

    describe('home airports', () => {
      /** The `search_awards` input minus the origin, which is what these vary. */
      const rest = {
        destination_airport: ['LHR'],
        only_direct_flights: false,
        include_trips: false,
        minify_trips: false,
        include_filtered: false,
        take: 100,
        skip: 0,
      };

      it('falls back to the stored setting when the caller named no origin', () => {
        // The whole point of the setting: somebody who always flies from the
        // same two airports should not retype them, and the model should not
        // have to guess them from conversation.
        const { params } = searchQuery({ ...rest }, new Date(), ['YVR', 'SEA']);
        expect(params.get('origin_airport')).toBe('YVR,SEA');
      });

      it('lets an explicit origin win over the setting', () => {
        // A default, not an override. Someone asking about a trip from JFK
        // means JFK, whatever their home airport says.
        const { params } = searchQuery({ ...rest, origin_airport: ['JFK'] }, new Date(), ['YVR']);
        expect(params.get('origin_airport')).toBe('JFK');
      });

      it('refuses rather than searching from everywhere', () => {
        // Seats.aero answers an impossible query with an empty 200, which reads
        // as "no award space" — so an unstated origin has to be an error here or
        // it becomes a wrong answer downstream.
        expect(() => searchQuery({ ...rest }, new Date())).toThrow(/origin_airport/);
        expect(() => searchQuery({ ...rest }, new Date())).toThrow(/settings/);
      });
    });

    describe('homeAirports', () => {
      it('reads the declared setting', () => {
        expect(homeAirports({ config: { home_airports: ['YVR'] } })).toEqual(['YVR']);
      });

      it('treats anything that is not a list of codes as unset', () => {
        // `ctx.config` is user-entered data that arrived through storage. A tool
        // that trusted its own setting's shape would be the one place in this
        // file that trusts an input.
        expect(homeAirports({ config: { home_airports: 'YVR' } })).toEqual([]);
        expect(homeAirports({ config: { home_airports: [1, 'YVR'] } })).toEqual(['YVR']);
        expect(homeAirports({ config: {} })).toEqual([]);
        expect(homeAirports({})).toEqual([]);
      });
    });
  });

  describe('paging', () => {
    it('leads with raising take, and calls paging lossy rather than routine', () => {
      // Measured against the live API: with the result set provably static (the
      // same query returns the same 20 ids in the same order), paging it as
      // 10 + 10 recovered 10 of the 20, repeated 3, and produced 7 the baseline
      // never contained. order_by=lowest_mileage recovered 1 of 20. So the
      // footer must not present skip/cursor as the route to a complete answer.
      const footer = pageFooter({ returned: 10, hasMore: true, nextSkip: 10, cursor: 42 });
      expect(footer).toContain('RAISE take AND RE-RUN');
      expect(footer).toContain('OMITS');
      expect(footer).toContain('skip=10 and cursor=42');
      expect(footer.indexOf('RAISE take')).toBeLessThan(footer.indexOf('skip=10'));
    });

    it('says nothing about paging on a final page', () => {
      const footer = pageFooter({ returned: 3, hasMore: false });
      expect(footer).toBe('3 result(s) — this is the last page.');
    });

    it('describes take as the primary size control', () => {
      const tool = server.tools.find((entry) => entry.name === 'search_awards');
      expect(tool.inputSchema.properties.take.description).toContain('PRIMARY SIZE CONTROL');
      expect(tool.inputSchema.properties.skip.description).toContain('omit');
    });
  });

  describe('response sizing', () => {
    it('clamps take when embedding trips would risk the gateway timeout', () => {
      // Measured: take=1000 alone is 2.1 MB / 1.6 s; the same with
      // include_trips is 11.5 MB / 8.4 s, at or past the hosted wall clock.
      const base = {
        origin_airport: ['SFO'],
        destination_airport: ['LHR'],
        only_direct_flights: false,
        include_filtered: false,
        skip: 0,
      };
      const plain = searchQuery(
        { ...base, take: 1000, include_trips: false, minify_trips: false },
        new Date(),
      );
      expect(plain.params.get('take')).toBe('1000');
      expect(plain.notes).toEqual([]);

      const withTrips = searchQuery(
        { ...base, take: 1000, include_trips: true, minify_trips: false },
        new Date(),
      );
      expect(withTrips.params.get('take')).toBe('200');
      expect(withTrips.notes.join(' ')).toContain('reduced from 1000 to 200');
      expect(withTrips.notes.join(' ')).toContain('minify_trips');

      const minified = searchQuery(
        { ...base, take: 1000, include_trips: true, minify_trips: true },
        new Date(),
      );
      expect(minified.params.get('take')).toBe('500');
    });

    it('leaves a page already under the ceiling alone', () => {
      const { params, notes } = searchQuery(
        {
          origin_airport: ['SFO'],
          destination_airport: ['LHR'],
          only_direct_flights: false,
          include_filtered: false,
          skip: 0,
          take: 50,
          include_trips: true,
          minify_trips: false,
        },
        new Date(),
      );
      expect(params.get('take')).toBe('50');
      expect(notes).toEqual([]);
    });
  });

  describe('the daily budget', () => {
    // Verified live: Seats.aero sends these on every response, success or not.
    const headers = {
      'x-ratelimit-limit': '1000',
      'x-ratelimit-remaining': '976',
      'x-ratelimit-reset': '21418',
    };

    it('reads the quota headers the reference never mentions', () => {
      const quota = readQuota(new Response('{}', { headers }));
      expect(quota).toEqual({ limit: 1000, remaining: 976, resetsIn: 21_418 });
      expect(untilReset(21_418)).toBe('5h 57m');
    });

    it('returns nothing when the API sends no quota headers', () => {
      expect(readQuota(new Response('{}'))).toBeUndefined();
    });

    it('stays quiet with plenty left and warns when nearly spent', () => {
      expect(quotaNote({ limit: 1000, remaining: 976, resetsIn: 21_418 })).toEqual([]);
      const warning = quotaNote({ limit: 1000, remaining: 12, resetsIn: 3600 }).join(' ');
      expect(warning).toContain('12 of 1000');
      expect(warning).toContain('resetting in 1h 0m');
      expect(warning).toContain('shared across every app');
    });

    it('reports the budget on a search and warns only when low', async () => {
      const flush = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { json: SEARCH, headers }),
      );
      expect(flush.result.structured.quota).toEqual({
        limit: 1000,
        remaining: 976,
        resetsIn: 21_418,
      });
      expect(flush.result.text).not.toContain('BUDGET');

      const nearlyOut = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { json: SEARCH, headers: { ...headers, 'x-ratelimit-remaining': '4' } }),
      );
      expect(nearlyOut.result.text).toContain('BUDGET: 4 of 1000');
    });

    it('says when the budget comes back rather than inviting a doomed retry', async () => {
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, {
          status: 429,
          text: 'rate limited',
          headers: { ...headers, 'x-ratelimit-remaining': '0' },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('resets in 5h 57m');
      expect(result.error).toContain('Retrying will not help');
    });
  });

  describe('availability decoding', () => {
    const [united, qantas, american] = SEARCH.data.map((item) => toAvailability(item));

    it('never presents the cheapest routing as the price of a non-stop', () => {
      // The defect this whole split exists for. United SFO→LHR economy is
      // 40,000 miles via DEN and 65,400 non-stop; the reference's field list
      // invites reporting 40,000 alongside `YDirect: true`.
      const economy = united.cabins.find((offer) => offer.cabin === 'economy');
      expect(economy.best.mileageCost).toBe(40_000);
      expect(economy.nonStop.mileageCost).toBe(65_400);
      expect(economy.bestIsNonStop).toBe(false);
    });

    it('reads per-cabin taxes and the record-level currency', () => {
      const economy = united.cabins.find((offer) => offer.cabin === 'economy');
      expect(economy.best.taxes).toEqual({ amount: 5.6, currency: 'USD', symbol: undefined });
      // Qantas levies real surcharges — 34900 minor units is $349.00, not $34,900.
      expect(qantas.cabins[0].best.taxes.amount).toBe(349);
    });

    it('reports a cabin with no surviving non-stop as having none', () => {
      const business = united.cabins.find((offer) => offer.cabin === 'business');
      expect(business.best.mileageCost).toBe(120_000);
      expect(business.best.airlines).toEqual(['B6']);
      expect(business.nonStop).toBeUndefined();
      expect(business.bestIsNonStop).toBe(false);
    });

    it('surfaces a cabin that exists only at dynamic pricing', () => {
      // United premium economy: WAvailable false, but WMileageCostRaw 135,900.
      // Dropping it would read as "no premium economy on this route".
      const premium = united.cabins.find((offer) => offer.cabin === 'premium');
      expect(premium.best).toBeUndefined();
      expect(premium.dynamic.best.mileageCost).toBe(135_900);
      expect(premium.dynamic.best.remainingSeats).toBe(9);
      expect(premium.dynamic.nonStop.mileageCost).toBe(135_900);
    });

    it('drops a cabin that is priced in neither view', () => {
      // American really does price first class unfiltered (305,000), so it is a
      // result. A cabin flagged available with nothing priced anywhere is not —
      // emitting it would render as an empty bullet.
      expect(american.cabins.map((offer) => offer.cabin)).toEqual(['economy', 'business', 'first']);
      const nothing = toAvailability({
        Source: 'american',
        FAvailable: false,
        FAvailableRaw: true,
        FMileageCost: '0',
        FMileageCostRaw: 0,
      });
      expect(nothing.cabins).toEqual([]);
    });

    it('never reports zero seats on a bookable cabin as sold out', () => {
      const economy = american.cabins.find((offer) => offer.cabin === 'economy');
      expect(economy.best.mileageCost).toBe(30_000);
      expect(economy.best.remainingSeats).toBeUndefined();
      expect(economy.best.airlines).toEqual(['AA', 'AS', 'BA']);
    });

    it('prefers a real seat count over any table that denies it', () => {
      // Qantas is listed in the reference as publishing no seat counts. It
      // published four — which is why the table now says 'partial' and why the
      // flag may only ever soften an explanation of a MISSING number.
      expect(qantas.cabins[0].best.remainingSeats).toBe(4);

      // Azul is still flagged 'no'. A count it did send must still be reported.
      const stubborn = toAvailability({
        Source: 'azul',
        YAvailable: true,
        YMileageCost: '20000',
        YRemainingSeats: 3,
      });
      expect(stubborn.cabins[0].seatsPublished).toBe(false);
      expect(stubborn.cabins[0].best.remainingSeats).toBe(3);
    });

    it('reads co-brand card rates for the cabin they price', () => {
      const economy = united.cabins.find((offer) => offer.cabin === 'economy');
      expect(economy.cardRates).toEqual([
        {
          card: 'UACARD',
          mileageCost: 36_000,
          nonStopMileageCost: 58_800,
          unlockedAirlines: ['UA'],
        },
        {
          card: 'UAELITECARD',
          mileageCost: 34_000,
          nonStopMileageCost: 55_500,
          unlockedAirlines: ['UA'],
        },
      ]);
      // The card block prices economy only; business must not inherit it.
      expect(united.cabins.find((offer) => offer.cabin === 'business').cardRates).toEqual([]);
    });

    it('reports the page honestly and never treats count as a total', () => {
      // Live: take=10 answers count:10 with hasMore true, so count is page size.
      const { page } = toPage(SEARCH, 0);
      expect(page.returned).toBe(3);
      expect(page.hasMore).toBe(true);
      expect(page.nextSkip).toBe(3);
      expect(page.reportedCount).toBe(3);
      expect(page.moreUrl).toContain('skip=10');
    });
  });

  describe('trip decoding', () => {
    const [viaDenver, viaChicago] = TRIPS.data.map((trip) => toTrip(trip));

    it('renders departure times as airport-local, never as UTC instants', () => {
      // SFO 14:05 → LHR 11:55 next day is 21h50m read as UTC. The trip reports
      // TotalDuration 830 minutes = 13h50m, which is only consistent if both are
      // local clocks — the 8h offset between PDT and BST.
      expect(viaChicago.departsLocal).toBe('2026-09-01 14:05');
      expect(viaChicago.arrivesLocal).toBe('2026-09-02 11:55');
      expect(viaChicago.duration).toBe('13h 50m');
      expect(JSON.stringify(viaChicago)).not.toContain('T14:05:00Z');
    });

    it('puts the legs in Order and derives the endpoints from them', () => {
      expect(viaChicago.segments.map((leg) => leg.flightNumber)).toEqual(['UA2199', 'UA938']);
      expect(viaChicago.origin).toBe('SFO');
      expect(viaChicago.destination).toBe('LHR');
      expect(viaChicago.segments[0].arrivesLocal).toBe('2026-09-01 20:40');
    });

    it('converts taxes out of minor units and keeps the currency', () => {
      expect(viaDenver.taxes).toEqual({ amount: 5.6, currency: 'USD', symbol: '$' });
    });

    it('reads the trip fields the reference omits entirely', () => {
      expect(viaDenver.connections).toEqual(['DEN']);
      expect(viaDenver.aircraft).toEqual(['Boeing 737 MAX 9', 'Boeing 787-9']);
      expect(viaDenver.cardRates).toEqual([
        { card: 'UACARD', mileageCost: 36_000, filtered: false },
        { card: 'UAELITECARD', mileageCost: 34_000, filtered: false },
      ]);
      expect(viaDenver.distance).toBeGreaterThan(0);
    });

    it('de-duplicates a carrier list the API repeats per leg', () => {
      // The API sends "UA, UA" for a two-leg single-carrier itinerary.
      expect(viaDenver.carriers).toEqual(['UA']);
      expect(viaDenver.flightNumbers).toEqual(['UA540', 'UA27']);
    });

    it('sorts legs by Order rather than trusting array position', () => {
      const reversed = toTrip({
        Source: 'aeroplan',
        AvailabilitySegments: [
          { FlightNumber: 'TK800', OriginAirport: 'PTY', DestinationAirport: 'IST', Order: 1 },
          { FlightNumber: 'CM326', OriginAirport: 'CUN', DestinationAirport: 'PTY', Order: 0 },
        ],
      });
      expect(reversed.segments.map((leg) => leg.flightNumber)).toEqual(['CM326', 'TK800']);
      expect(reversed.origin).toBe('CUN');
      expect(reversed.destination).toBe('IST');
    });

    it('leaves live-search legs alone, since those carry no Order', () => {
      const live = toTrip({
        Source: 'qantas',
        AvailabilitySegments: [
          { FlightNumber: 'QF433', OriginAirport: 'SYD', DestinationAirport: 'MEL' },
          { FlightNumber: 'QF616', OriginAirport: 'MEL', DestinationAirport: 'PER' },
        ],
      });
      expect(live.segments.map((leg) => leg.flightNumber)).toEqual(['QF433', 'QF616']);
      expect(live.origin).toBe('SYD');
      expect(live.destination).toBe('PER');
    });

    it('reads a number the API sent as a string', () => {
      const stringy = toTrip({ Source: 'aeroplan', MileageCost: '70000', TotalTaxes: '1290' });
      expect(stringy.mileageCost).toBe(70_000);
      expect(stringy.taxes?.amount).toBe(12.9);
    });

    it('formats durations and passes odd values through safely', () => {
      expect(fmtDuration(45)).toBe('45m');
      expect(fmtDuration(0)).toBeUndefined();
      expect(fmtDuration(JSON.parse('{}').TotalDuration)).toBeUndefined();
      expect(localTime('')).toBeUndefined();
      expect(localTime('not-a-date')).toBe('not-a-date');
    });
  });

  describe('minified trips', () => {
    // A real include_trips=true&minify_trips=true capture. Minified trips keep
    // nine fields and lose Source, TaxesCurrency and the segments entirely.
    const [availability] = MINIFIED.data.map((item) => toAvailability(item));

    it('inherits the program and currency the minified trip does not carry', () => {
      const [trip] = availability.trips;
      expect(trip.source).toBe('united');
      expect(trip.program).toBe('United MileagePlus');
      expect(trip.taxes.currency).toBe('USD');
      // Without inheritance this reads "unknown program" and an unlabelled sum.
      expect(trip.program).not.toContain('unknown');
    });

    it('keeps the nine fields minify preserves', () => {
      const [trip] = availability.trips;
      expect(trip.mileageCost).toBeGreaterThan(0);
      expect(trip.cabin).toBeTruthy();
      expect(trip.duration).toBeTruthy();
      expect(typeof trip.stops).toBe('number');
      expect(trip.carriers.length).toBeGreaterThan(0);
    });

    it('renders a priced line rather than a row of question marks', () => {
      const lines = availability.trips.flatMap((trip) => tripLines(trip));
      // Availabilities carry a currency code but no symbol, so "5.60 USD" is
      // the honest rendering — a symbol is never guessed from the code.
      expect(lines[0]).toContain(' USD ');
      expect(lines[0]).toContain(' mi + ');
      expect(lines[0]).not.toContain('unknown program');
      // Stops survive minify even though the connection airports do not.
      expect(/non-stop| \d stops?/.test(lines[0])).toBe(true);
      // No segments came back, so no leg lines are invented.
      expect(availability.trips[0].segments).toEqual([]);
      expect(lines).toHaveLength(availability.trips.length);
    });
  });

  describe('search_awards', () => {
    it('builds the documented query and summarises the page honestly', async () => {
      let seen = '';
      const result = await callTool(
        server,
        'search_awards',
        {
          origin_airport: ['sfo', 'oak'],
          destination_airport: ['LHR'],
          start_date: '2026-09-01',
          end_date: '2026-09-30',
          cabins: ['business'],
          sources: ['alaska', 'american', 'qantas'],
          only_direct_flights: true,
          take: 100,
        },
        withSecret(KEY, (url) => {
          seen = url;
          return { json: SEARCH };
        }),
      );
      expect(result.ok).toBe(true);
      expect(seen).toContain('origin_airport=SFO%2COAK');
      expect(seen).toContain('destination_airport=LHR');
      expect(seen).toContain('start_date=2026-09-01');
      expect(seen).toContain('cabins=business');
      expect(seen).toContain('sources=alaska%2Camerican%2Cqantas');
      expect(seen).toContain('only_direct_flights=true');
      expect(seen).toContain('take=100');

      expect(result.result.structured.page.returned).toBe(3);
      expect(result.result.text).toContain('MORE ARE AVAILABLE');
      expect(result.result.text).toContain('RAISE take AND RE-RUN');
      expect(result.result.text).toContain('skip=3 and cursor=1785516212');
      expect(result.result.text).toContain('OMITS');
      // The headline correction, end to end: the cheap price is labelled as
      // needing a connection and the non-stop is priced separately.
      expect(result.result.text).toContain(
        '40,000 mi + 5.60 USD · 9 seats · UA · with a connection',
      );
      expect(result.result.text).toContain('cheapest non-stop: 65,400 mi');
      expect(result.result.text).toContain('premium  ONLY at dynamic pricing: 135,900 mi');
    });

    it('sends the API key in the Partner-Authorization header', async () => {
      let header;
      await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, (_url, init) => {
          header = new Headers(init?.headers).get('partner-authorization');
          return { json: SEARCH };
        }),
      );
      expect(header).toBe(KEY);
    });

    it('rejects a bad airport before spending an API call', async () => {
      let isCalled = false;
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['San Francisco'], destination_airport: ['LHR'] },
        withSecret(KEY, () => {
          isCalled = true;
          return { json: SEARCH };
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a 3-letter IATA/);
      expect(isCalled).toBe(false);
    });

    it('renders embedded trips when include_trips is on', async () => {
      const withTrips = structuredClone(SEARCH);
      withTrips.data = [withTrips.data[0]];
      withTrips.data[0].AvailabilityTrips = TRIPS.data;
      let seen = '';
      const result = await callTool(
        server,
        'search_awards',
        {
          origin_airport: ['SFO'],
          destination_airport: ['LHR'],
          include_trips: true,
          minify_trips: true,
        },
        withSecret(KEY, (url) => {
          seen = url;
          return { json: withTrips };
        }),
      );
      expect(seen).toContain('include_trips=true');
      expect(seen).toContain('minify_trips=true');
      expect(result.result.structured.results[0].trips).toHaveLength(2);
      expect(result.result.text).toContain('UA540 SFO→DEN');
    });

    it('says how many rows the summary left out', async () => {
      const many = structuredClone(SEARCH);
      const [template] = many.data;
      many.data = Array.from({ length: 45 }, (_unused, index) => ({
        ...template,
        ID: `avail-${index}`,
      }));
      many.hasMore = false;
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { json: many }),
      );
      expect(result.result.structured.results).toHaveLength(45);
      expect(result.result.text).toContain('5 more in this page omitted from the summary');
    });

    it('echoes an opaque cursor back verbatim, whatever type it arrives as', async () => {
      let seen = '';
      const stringCursor = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { text: '{"data":[],"hasMore":true,"cursor":"opaque-token"}' }),
      );
      expect(stringCursor.result.structured.page.cursor).toBe('opaque-token');

      await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'], cursor: 'opaque-token', skip: 10 },
        withSecret(KEY, (url) => {
          seen = url;
          return { json: SEARCH };
        }),
      );
      expect(seen).toContain('cursor=opaque-token');
      expect(seen).toContain('skip=10');
    });

    it('survives an unexpected field type instead of failing the call', async () => {
      // A lenient parse schema is the point: one drifted field must not turn a
      // good page of results into an error.
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, {
          text: '{"data":[{"ID":"a","Source":"alaska","Date":"2026-09-11","YAvailable":true,"YMileageCost":"30000","Route":{"OriginAirport":"SFO","DestinationAirport":"LHR","Distance":"5359"}}],"count":"42","hasMore":false}',
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.results[0].distance).toBe(5359);
      expect(result.result.structured.page.reportedCount).toBe(42);
    });

    it('reaches the award space include_filtered exists to unlock', async () => {
      // A capture of a real include_filtered=true page. The united row carries a
      // premium-economy cabin that is invisible in every non-Raw field, so a
      // decoder reading only those would make the flag look like a no-op.
      let seen = '';
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'], include_filtered: true },
        withSecret(KEY, (url) => {
          seen = url;
          return { json: SEARCH_FILTERED };
        }),
      );
      expect(seen).toContain('include_filtered=true');
      const premium = result.result.structured.results[0].cabins.find(
        (offer) => offer.cabin === 'premium',
      );
      expect(premium.best).toBeUndefined();
      expect(premium.dynamic.best.mileageCost).toBe(135_900);
      expect(result.result.text).toContain('ONLY at dynamic pricing');
    });

    it('says an empty page is empty without claiming a total', async () => {
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { text: '{"data":[],"count":0,"hasMore":false,"cursor":0}' }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.text).toContain('No award availability matched this search');
      // An empty result must name the filters that silently produce one.
      expect(result.result.text).toContain('does not serve the');
      expect(result.result.text).toContain('this is the last page');
    });
  });

  describe('explore_availability', () => {
    it('sends the source, region and cabin filters', async () => {
      let seen = '';
      const result = await callTool(
        server,
        'explore_availability',
        {
          source: 'aeroplan',
          cabin: 'business',
          origin_region: 'North America',
          destination_region: 'Europe',
          take: 500,
        },
        withSecret(KEY, (url) => {
          seen = url;
          return { json: SEARCH };
        }),
      );
      expect(result.ok).toBe(true);
      expect(seen).toContain('/availability?');
      expect(seen).toContain('source=aeroplan');
      expect(seen).toContain('cabin=business');
      expect(seen).toContain('origin_region=North+America');
      expect(seen).toContain('take=500');
    });

    it('refuses an unknown program', async () => {
      const result = await callTool(
        server,
        'explore_availability',
        { source: 'lifemiles' },
        withSecret(KEY, { json: SEARCH }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a Seats\.aero mileage program/);
    });
  });

  describe('get_trips', () => {
    it('expands an availability into flights and booking links', async () => {
      const result = await callTool(
        server,
        'get_trips',
        { availability_id: 'avail-alaska' },
        withSecret(KEY, { json: TRIPS }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.text).toContain('UA2199 SFO→ORD 2026-09-01 14:05');
      expect(result.result.text).toContain('(local)');
      expect(result.result.text).toContain('$5.60 USD');
      expect(result.result.text).toContain('Book via United MileagePlus');
      // Cheapest first, so a capped summary keeps the useful end.
      expect(result.result.structured.trips[0].mileageCost).toBe(40_000);
    });

    it('filters to one cabin', async () => {
      const kept = await callTool(
        server,
        'get_trips',
        { availability_id: 'avail-united', cabin: 'economy' },
        withSecret(KEY, { json: TRIPS }),
      );
      expect(kept.result.structured.count).toBe(2);

      const none = await callTool(
        server,
        'get_trips',
        { availability_id: 'avail-united', cabin: 'first' },
        withSecret(KEY, { json: TRIPS }),
      );
      expect(none.result.structured.count).toBe(0);
      // An empty filter result must not read like an empty availability.
      expect(none.result.text).toContain('No first trips among the 2 returned');
    });

    it('does not present a program that publishes no taxes as tax-free', async () => {
      const qatar = {
        data: [
          {
            ID: 'trip-qatar',
            AvailabilitySegments: [],
            Stops: 0,
            Carriers: 'QR',
            RemainingSeats: 0,
            MileageCost: 70_000,
            TotalTaxes: 0,
            TaxesCurrency: '',
            Cabin: 'business',
            Source: 'qatar',
          },
        ],
        booking_links: [],
      };
      const result = await callTool(
        server,
        'get_trips',
        { availability_id: 'avail-qatar' },
        withSecret(KEY, { json: qatar }),
      );
      const [trip] = result.result.structured.trips;
      expect(trip.taxes).toBeUndefined();
      expect(result.result.text).toContain('taxes not published by this program');
      expect(result.result.text).toContain('seats not reported');
      expect(result.result.text).not.toContain('$0.00');
    });

    it('explains an empty trip list rather than implying no space', async () => {
      const result = await callTool(
        server,
        'get_trips',
        { availability_id: 'avail-alaska' },
        withSecret(KEY, { text: '{"data":[],"booking_links":[]}' }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.text).toContain('does not publish trip data');
    });

    it('rejects an id that is obviously not one', async () => {
      const result = await callTool(server, 'get_trips', { availability_id: 'SFO → LHR' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/is not a Seats\.aero id/);
    });
  });

  describe('live_search', () => {
    it('posts the documented body and reads the results', async () => {
      let body;
      const result = await callTool(
        server,
        'live_search',
        {
          origin_airport: 'syd',
          destination_airport: 'mel',
          departure_date: '2026-09-20',
          source: 'qantas',
          seat_count: 2,
        },
        withSecret(KEY, (url, init) => {
          if (url.endsWith('/live')) {
            body = JSON.parse(init.body);
            return { text: LIVE_JSON };
          }
          throw new Error(`unexpected request: ${url}`);
        }),
      );
      expect(result.ok).toBe(true);
      expect(body).toMatchObject({
        origin_airport: 'SYD',
        destination_airport: 'MEL',
        departure_date: '2026-09-20',
        source: 'qantas',
        seat_count: 2,
      });
      expect(result.result.structured.count).toBe(1);
      expect(result.result.text).toContain('18,000 mi');
      expect(result.result.text).toContain('$94.89 AUD');
      expect(result.result.text).toContain('Qantas Frequent Flyer live search');
    });

    it('points a multi-airport request back at search_awards', async () => {
      const result = await callTool(server, 'live_search', {
        origin_airport: 'SFO,OAK',
        destination_airport: 'LHR',
        departure_date: '2026-09-20',
        source: 'qantas',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/exactly one origin and one destination/);
    });

    it('raises a failure that arrived inside an HTTP 200', async () => {
      const result = await callTool(
        server,
        'live_search',
        {
          origin_airport: 'SYD',
          destination_airport: 'MEL',
          departure_date: '2026-09-20',
          source: 'qantas',
        },
        withSecret(KEY, { text: '{"success":false,"error":"unsupported source"}' }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/unsupported source/);
    });

    it('names the documented OAuth-token limitation instead of 401ing', async () => {
      const result = await callTool(
        server,
        'live_search',
        {
          origin_airport: 'SYD',
          destination_airport: 'MEL',
          departure_date: '2026-09-20',
          source: 'qantas',
        },
        withSecret('seats:ota:xyz', () => {
          throw new Error('should not have called out');
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/cannot be used with a Seats\.aero OAuth2 access token/);
    });

    it('says an empty live result is a live answer, not a cache miss', async () => {
      const result = await callTool(
        server,
        'live_search',
        {
          origin_airport: 'SYD',
          destination_airport: 'MEL',
          departure_date: '2026-09-20',
          source: 'qantas',
        },
        withSecret(KEY, { text: '{"results":[],"bookingLinks":[],"success":true}' }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.text).toContain('not a cache miss');
    });
  });

  describe('the trip summary', () => {
    it('guarantees a line per cabin so include_filtered is visible', () => {
      // A live availability returns 59 trips plain and 178 with include_filtered
      // — and the extra 119 hold the only premium options, all dearer than every
      // economy award. Ranked purely by price the flag looks like it did nothing.
      const trips = [
        ...Array.from({ length: 30 }, (_unused, index) => trip('economy', 40_000 + index)),
        trip('business', 200_000),
        trip('premium', 135_900),
      ];
      const shown = summarise(trips, 25);
      expect(shown).toHaveLength(25);
      expect(new Set(shown.map((t) => t.cabin))).toEqual(
        new Set(['economy', 'premium', 'business']),
      );
      // Still cheapest-first to read.
      const prices = shown.map((t) => t.mileageCost);
      expect(prices).toEqual(prices.toSorted((a, b) => a - b));
      expect(shown[0].mileageCost).toBe(40_000);
    });

    it('never drops a cabin even when cabins outnumber the cap', () => {
      const trips = [trip('economy', 1), trip('premium', 2), trip('business', 3), trip('first', 4)];
      expect(summarise(trips, 2).map((t) => t.cabin)).toEqual([
        'economy',
        'premium',
        'business',
        'first',
      ]);
    });

    it('is a no-op when everything fits', () => {
      const trips = [trip('economy', 10), trip('business', 20)];
      expect(summarise(trips, 25)).toEqual(trips);
    });
  });

  describe('the hand-rolled transport guards', () => {
    // seatsJson uses ctx.fetch (the quota is header-only), so the guards
    // ctx.fetchJson would have applied are reproduced by hand. Each is asserted
    // here rather than left as a claim in a comment.
    const search = { origin_airport: ['SFO'], destination_airport: ['LHR'] };

    it('treats an unreachable upstream as retryable', async () => {
      const result = await callTool(
        server,
        'search_awards',
        search,
        withSecret(KEY, () => {
          throw new Error('ECONNRESET');
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/Could not reach Seats\.aero/);
    });

    it('treats a 200 carrying non-JSON as retryable', async () => {
      const result = await callTool(
        server,
        'search_awards',
        search,
        withSecret(KEY, { text: '<html>maintenance</html>' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/non-JSON/);
    });

    it('treats a 200 of the wrong shape as retryable, not as an empty result', async () => {
      const result = await callTool(
        server,
        'search_awards',
        search,
        withSecret(KEY, { json: [1, 2, 3] }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/unexpected shape/);
    });

    it('never leaks the key through any of them', async () => {
      for (const spec of [{ text: 'nope' }, { json: [] }, { status: 500, text: 'boom' }]) {
        const result = await callTool(server, 'search_awards', search, withSecret(KEY, spec));
        expect(result.ok).toBe(false);
        expect(result.error).not.toContain(KEY);
      }
    });
  });

  describe('errors', () => {
    it('points a rejected key at the secret and the Pro requirement', async () => {
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { status: 401, text: '{"error":"invalid api key"}' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/SEATS_AERO_API_KEY/);
      expect(result.error).toMatch(/Pro subscription/);
    });

    it('does not blame the key when Seats.aero refuses to entitle live search', async () => {
      // Verified live: a working Pro key gets this exact 401 from /live. Telling
      // the user to check their key would send them to replace a good one.
      const result = await callTool(
        server,
        'live_search',
        {
          origin_airport: 'SFO',
          destination_airport: 'LHR',
          departure_date: '2026-09-01',
          source: 'united',
        },
        withSecret(KEY, {
          status: 401,
          text: '{"success":false,"error":"Your API key is not enabled for the live search API. Live search requires a commercial agreement with seats.aero."}',
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('requires a commercial agreement');
      expect(result.error).toContain('The key itself is fine');
      expect(result.error).not.toMatch(/Check the SEATS_AERO_API_KEY/);
    });

    it('still blames the key for a genuinely bad one', async () => {
      // The live API answers a bad key with the bare string `bad_partner_key`.
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { status: 401, text: 'bad_partner_key' }),
      );
      expect(result.error).toContain('bad_partner_key');
      expect(result.error).toMatch(/Check the SEATS_AERO_API_KEY/);
    });

    it('does not send a spent daily quota back into a retry loop', async () => {
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { status: 429, text: 'rate limited' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/daily quota exhausted/);
      expect(result.error).toMatch(/Retrying will not help/);
    });

    it('retries a rate limit that carries a Retry-After', async () => {
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { status: 429, text: 'slow down', headers: { 'retry-after': '30' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/Wait 30s/);
    });

    it('treats a 5xx as retryable and never leaks the key', async () => {
      const result = await callTool(
        server,
        'search_awards',
        { origin_airport: ['SFO'], destination_airport: ['LHR'] },
        withSecret(KEY, { status: 503, text: 'upstream down' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).not.toContain(KEY);
    });
  });

  describe('list_programs', () => {
    it('answers from the local table without any network call', async () => {
      const result = await callTool(server, 'list_programs', {});
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(26);
      expect(result.result.text).toContain('aeroplan');
      expect(result.result.text).toContain('NO seat counts');
      expect(result.result.text).toContain('NO taxes/surcharges');
    });

    it('filters to programs searchable in a cabin', async () => {
      const result = await callTool(server, 'list_programs', { cabin: 'first' });
      const slugs = result.result.structured.programs.map((program) => program.source);
      expect(slugs).toContain('aeroplan');
      expect(slugs).not.toContain('eurobonus');
    });

    it('is not annotated as reaching the open world', () => {
      const tool = server.tools.find((entry) => entry.name === 'list_programs');
      expect(tool.annotations.openWorldHint).toBe(false);
    });
  });
});
