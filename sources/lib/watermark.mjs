/**
 * Typed watermark values for source adapters — re-exported from `@ontrove/sdk`.
 *
 * The SDK's `watermark` module was written from THIS file, so what follows is
 * the same code under a new owner rather than a substitute for it. Keeping the
 * specifier `sources/lib/watermark.mjs` means every adapter and every test goes
 * on importing what it always did while the implementation lives in one place
 * for all three runtimes (Trove's deployed shim, the CLI's local shim, and the
 * Mac harness) instead of once per catalog.
 *
 * `sources/lib/watermark.test.mjs` still runs against these exports, and that
 * is the point of it: it is this catalog's proof that the SDK's behaviour is
 * the behaviour these sources need. If it ever fails, the two have diverged.
 *
 * The full union is `docs/source-adapter-taxonomy.md` §4.3. MVP implements
 * three strategies: `date`, `idSet` (bounded), and `none` — the last being no
 * cursor at all, which an adapter expresses by returning `undefined`.
 *
 * One thing worth restating locally, because it is the reason `MAX_ID_SET_BYTES`
 * exists at all: the platform refuses a cursor over 65,536 bytes, and
 * {@link DEFAULT_ID_SET_MAX} counts ENTRIES, not bytes. A scrape source in the
 * private catalog reached the byte limit after 571 posts and every run after
 * that was refused, so it could not advance past the point where it broke. This
 * catalog has never hit it — but only because the one id set it writes today
 * happens to be short, not because anything here prevents it.
 *
 * @module
 */

export {
  advanceDateWatermark,
  DEFAULT_ID_SET_MAX,
  dateWatermark,
  idSetWatermark,
  MAX_ID_SET_BYTES,
  readDateWatermark,
  readIdSet,
} from '@ontrove/sdk';
