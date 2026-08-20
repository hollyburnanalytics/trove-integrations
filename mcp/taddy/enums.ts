/**
 * Taddy's controlled vocabularies — podcast genres, countries, languages — and
 * the forgiving lookup that maps what a caller actually types onto them.
 *
 * The vocabularies themselves live in `vocab/` — transcribed from Taddy's
 * published GraphQL schema (https://ax0.taddy.org/docs/schema.graphql) — and
 * this module is the lookup over them.
 *
 * **Why a lookup and not a `z.enum`.** These are the argument values a model is
 * most likely to get wrong, because nobody writes
 * `PODCASTSERIES_HEALTH_AND_FITNESS_MENTAL_HEALTH` unprompted — they write
 * "mental health", "Health & Fitness > Mental Health", or "health/mental
 * health". A raw enum answers all three with a schema violation listing 110
 * alternatives. So the tools take free text, canonicalise it (case, punctuation,
 * separators and the `PODCASTSERIES_` prefix all stop mattering), and on a genuine
 * miss raise a {@link ToolError} naming the closest real values — the same
 * "did you mean" contract the rest of the repo uses for an unknown slug.
 */

import { ToolError } from '@ontrove/extend/toolkit';
import { COUNTRIES } from './vocab/countries.ts';
import { PODCAST_GENRES } from './vocab/genres.ts';
import { LANGUAGES } from './vocab/languages.ts';

export { COUNTRIES, LANGUAGES, PODCAST_GENRES };

export type PodcastGenre = (typeof PODCAST_GENRES)[number];
export type CountryCode = (typeof COUNTRIES)[number];
export type LanguageCode = (typeof LANGUAGES)[number];

/**
 * Reduce a value to its comparable core: letters and digits only, uppercased.
 *
 * This is what makes `"Health & Fitness > Mental Health"`,
 * `"health-and-fitness/mental-health"` and the literal enum member all collapse
 * to the same key. The `AND` → `&` equivalence is handled by mapping `&` to the
 * word, not by dropping it, so "Kids & Family" meets `KIDS_AND_FAMILY`.
 */
function canonical(value: string): string {
  return value
    .replaceAll('&', 'AND')
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, '');
}

/** Build a canonical-form → enum-value index for one vocabulary. */
function index(values: readonly string[], stripPrefix = ''): Map<string, string> {
  const map = new Map<string, string>();
  for (const value of values) {
    map.set(canonical(value), value);
    if (stripPrefix && value.startsWith(stripPrefix)) {
      // So a caller may write "true crime" instead of "PODCASTSERIES_TRUE_CRIME".
      map.set(canonical(value.slice(stripPrefix.length)), value);
    }
  }
  return map;
}

const GENRE_INDEX = index(PODCAST_GENRES, 'PODCASTSERIES_');
const COUNTRY_INDEX = index(COUNTRIES);
const LANGUAGE_INDEX = index(LANGUAGES);

/**
 * Names and codes that no amount of canonicalisation reaches.
 *
 * Taddy spells several countries in ways nobody types: the US is
 * `UNITED_STATES_OF_AMERICA`, and the Koreas are inverted into `KOREA_SOUTH` /
 * `KOREA_NORTH`, so "South Korea" canonicalises to `SOUTHKOREA` and misses. ISO
 * alpha-2 codes are here for the same reason — "US", "GB", "DE" are what a model
 * reaches for first, and they resemble nothing in the enum.
 *
 * This is deliberately a short list of the common cases rather than a full ISO
 * table: everything else already resolves by name, and an unknown value gets
 * near-matches rather than silence.
 */
const COUNTRY_ALIASES: Record<string, CountryCode> = {
  US: 'UNITED_STATES_OF_AMERICA',
  USA: 'UNITED_STATES_OF_AMERICA',
  AMERICA: 'UNITED_STATES_OF_AMERICA',
  UNITEDSTATES: 'UNITED_STATES_OF_AMERICA',
  GB: 'UNITED_KINGDOM',
  UK: 'UNITED_KINGDOM',
  BRITAIN: 'UNITED_KINGDOM',
  GREATBRITAIN: 'UNITED_KINGDOM',
  ENGLAND: 'UNITED_KINGDOM',
  CA: 'CANADA',
  AU: 'AUSTRALIA',
  NZ: 'NEW_ZEALAND',
  IE: 'IRELAND',
  DE: 'GERMANY',
  FR: 'FRANCE',
  ES: 'SPAIN',
  IT: 'ITALY',
  NL: 'NETHERLANDS',
  SE: 'SWEDEN',
  NO: 'NORWAY',
  DK: 'DENMARK',
  FI: 'FINLAND',
  BR: 'BRAZIL',
  MX: 'MEXICO',
  AR: 'ARGENTINA',
  IN: 'INDIA',
  JP: 'JAPAN',
  CN: 'CHINA',
  ZA: 'SOUTH_AFRICA',
  SOUTHKOREA: 'KOREA_SOUTH',
  KR: 'KOREA_SOUTH',
  NORTHKOREA: 'KOREA_NORTH',
  CZECHREPUBLIC: 'CZECHIA',
  UAE: 'UNITED_ARAB_EMIRATES',
  HOLLAND: 'NETHERLANDS',
};

/** Language names a caller is likely to give that the enum spells differently. */
const LANGUAGE_ALIASES: Record<string, LanguageCode> = {
  EN: 'ENGLISH',
  ES: 'SPANISH',
  FR: 'FRENCH',
  DE: 'GERMAN',
  IT: 'ITALIAN',
  PT: 'PORTUGUESE',
  NL: 'DUTCH_FLEMISH',
  SV: 'SWEDISH',
  JA: 'JAPANESE',
  ZH: 'CHINESE',
  MANDARIN: 'CHINESE',
  KO: 'KOREAN',
  RU: 'RUSSIAN',
  AR: 'ARABIC',
  HI: 'HINDI',
};

/**
 * The closest real values to a miss, for the error message.
 *
 * Substring containment in either direction, which covers the two ways a guess
 * actually goes wrong: too specific ("investing podcasts" → `..._INVESTING`) and
 * too vague ("health" → the six `HEALTH_AND_FITNESS_*` members).
 */
function nearMatches(wanted: string, values: readonly string[], limit = 6): string[] {
  const key = canonical(wanted);
  if (key.length < 3) return [];
  return values
    .filter((value) => {
      // Compare against the value WITHOUT its `PODCASTSERIES_` prefix. Compared
      // with it, no guess a human would make can ever match: "sports" does not
      // appear in "PODCASTSERIESSPORTS" as a prefix or suffix, so every genre
      // miss fell through to the generic "use one of Taddy's values" — the
      // suggestions this function exists to provide never fired at all.
      const candidate = canonical(value.replace(/^PODCASTSERIES_/, ''));
      return candidate.includes(key) || key.includes(candidate);
    })
    .slice(0, limit);
}

/** The shortest partial name worth resolving; below this, guesses are noise. */
const MIN_PARTIAL_LENGTH = 3;

/**
 * Values whose name STARTS with the given text.
 *
 * Taddy qualifies many proper nouns — `BOLIVIA_PLURINATIONAL_STATE_OF`,
 * `VENEZUELA_BOLIVARIAN_REPUBLIC_OF`, `DUTCH_FLEMISH` — and a caller naturally
 * writes only the head. Anchoring at the START is what keeps that useful and
 * safe: "Bolivia" reaches the right country, while "Africa" matches nothing and
 * is told so, instead of silently becoming `SOUTH_AFRICA`.
 */
function byLeadingName(key: string, all: readonly string[], strip: RegExp): string[] {
  return all.filter((candidate) => canonical(candidate.replace(strip, '')).startsWith(key));
}

/**
 * Values whose name ENDS with the given text, at a segment boundary.
 *
 * Only genres get this, and only because a genre is a PATH: `..._INVESTING` and
 * `..._MENTAL_HEALTH` are leaves whose last segment is the name a person
 * actually uses, so naming the leaf is the normal way to ask. Countries and
 * languages are flat proper nouns where a trailing fragment is a coincidence,
 * not an abbreviation — matching it is how "Dutch" became
 * `SINT_MAARTEN_DUTCH_PART` and "Africa" became `SOUTH_AFRICA`.
 *
 * The boundary check is what separates a leaf from a coincidence:
 * `SPORTS_FANTASY_SPORTS` does not end at `FANTASY`, so "fantasy" is refused
 * rather than resolved to fantasy sports.
 */
function byTrailingName(key: string, all: readonly string[], strip: RegExp): string[] {
  return all.filter((candidate) => {
    const segments = candidate.replace(strip, '').split('_');
    // Join progressively longer tails: HEALTH, MENTAL_HEALTH, FITNESS_MENTAL_HEALTH…
    return segments.some(
      (_, index) => index > 0 && canonical(segments.slice(index).join('_')) === key,
    );
  });
}

interface ResolveOptions {
  lookup: Map<string, string>;
  aliases: Record<string, string>;
  all: readonly string[];
  what: string;
  /** Prefix stripped before matching partial names (genres only). */
  strip?: string;
  /** Allow a leaf (trailing-name) match. Genres only — see {@link byTrailingName}. */
  allowLeaf?: boolean;
}

/**
 * Resolve one free-text value against a vocabulary, or throw with suggestions.
 *
 * Four steps, narrowest first: exact/alias, then leading-name, then (genres
 * only) leaf name. A partial match resolves ONLY when it identifies a single
 * value — "Korea" names two countries and "Norwegian" two languages, and
 * choosing one would be a silent guess about which the caller meant.
 */
function resolve<T extends string>(value: string, options: ResolveOptions): T {
  const { lookup, aliases, all, what, strip = '', allowLeaf = false } = options;
  const key = canonical(value);
  const exact = aliases[key] ?? lookup.get(key);
  if (exact) return exact as T;

  if (key.length >= MIN_PARTIAL_LENGTH) {
    const stripPattern = strip === '' ? /^$/ : new RegExp(`^${strip}`);
    const partial = [
      byLeadingName(key, all, stripPattern),
      ...(allowLeaf ? [byTrailingName(key, all, stripPattern)] : []),
    ].find((matches) => matches.length > 0);

    const only = partial?.[0];
    if (partial && only && partial.length === 1) return only as T;
    if (partial && partial.length > 1) {
      throw new ToolError(
        `"${value}" matches more than one Taddy ${what}: ${partial.join(', ')}. Pick one.`,
        { retryable: false },
      );
    }
  }

  const near = nearMatches(value, all);
  throw new ToolError(
    `"${value}" is not a Taddy ${what}.` +
      (near.length > 0
        ? ` Closest matches: ${near.join(', ')}.`
        : ` Use one of Taddy's ${what} values (e.g. ${all.slice(0, 3).join(', ')}).`),
    { retryable: false },
  );
}

/** Resolve a podcast genre, e.g. `"true crime"` → `PODCASTSERIES_TRUE_CRIME`. */
export function resolveGenre(value: string): PodcastGenre {
  return resolve<PodcastGenre>(value, {
    lookup: GENRE_INDEX,
    aliases: {},
    all: PODCAST_GENRES,
    what: 'genre',
    strip: 'PODCASTSERIES_',
    // A genre is a path, so its leaf ("investing", "mental health") is a name.
    allowLeaf: true,
  });
}

/** Resolve a country, e.g. `"US"` → `UNITED_STATES_OF_AMERICA`. */
export function resolveCountry(value: string): CountryCode {
  return resolve<CountryCode>(value, {
    lookup: COUNTRY_INDEX,
    aliases: COUNTRY_ALIASES,
    all: COUNTRIES,
    what: 'country',
  });
}

/** Resolve a language, e.g. `"en"` → `ENGLISH`. */
export function resolveLanguage(value: string): LanguageCode {
  return resolve<LanguageCode>(value, {
    lookup: LANGUAGE_INDEX,
    aliases: LANGUAGE_ALIASES,
    all: LANGUAGES,
    what: 'language',
  });
}

/** Resolve a list of genres, preserving order and dropping duplicates. */
export function resolveGenres(values: readonly string[]): PodcastGenre[] {
  return [...new Set(values.map((value) => resolveGenre(value)))];
}

/** Resolve a list of countries, preserving order and dropping duplicates. */
export function resolveCountries(values: readonly string[]): CountryCode[] {
  return [...new Set(values.map((value) => resolveCountry(value)))];
}

/** Resolve a list of languages, preserving order and dropping duplicates. */
export function resolveLanguages(values: readonly string[]): LanguageCode[] {
  return [...new Set(values.map((value) => resolveLanguage(value)))];
}

/**
 * Present a genre for humans: `PODCASTSERIES_HEALTH_AND_FITNESS_MEDICINE` →
 * `Health & Fitness › Medicine`. The enum value is what the API speaks; this is
 * what a reader should see.
 */
export function formatGenre(genre: string): string {
  const body = genre.replace(/^PODCASTSERIES_/, '');
  const parent = GENRE_BODIES.find((candidate) => body.startsWith(`${candidate}_`));
  if (!parent) return titleCase(body);
  return `${titleCase(parent)} › ${titleCase(body.slice(parent.length + 1))}`;
}

/**
 * Present a content role for humans: `PODCASTSERIES_HOST` → `host`.
 *
 * Taddy namespaces `ContentRole` the same way it namespaces genres, so an
 * un-formatted credit list reads "Justin Jackson (PODCASTSERIES_HOST)" — the
 * API's vocabulary leaking into a sentence about a person. Live output is what
 * surfaced this; the fixtures all used already-friendly role strings.
 */
export function formatRole(role: string): string {
  return role
    .replace(/^PODCASTSERIES_/, '')
    .toLowerCase()
    .replaceAll('_', ' ');
}

/** `HEALTH_AND_FITNESS` → `Health & Fitness`. */
function titleCase(part: string): string {
  return part
    .split('_')
    .map((word) => (word === 'AND' ? '&' : word.charAt(0) + word.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * Every genre name without its prefix, longest first — the candidate parents
 * {@link formatGenre} splits on.
 *
 * Longest-first is what keeps a two-level name intact: `HEALTH_AND_FITNESS`
 * must win over any shorter member that also prefixes it, or the split lands
 * mid-name. The match is deliberately STRICT (`startsWith(parent + '_')`), so a
 * genre is never treated as its own parent — testing equality here would render
 * `ARTS_BOOKS` as "Arts Books" instead of "Arts › Books".
 */
const GENRE_BODIES: string[] = PODCAST_GENRES.map((genre) =>
  genre.replace(/^PODCASTSERIES_/, ''),
).sort((a, b) => b.length - a.length);
