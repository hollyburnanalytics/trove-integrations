import type { FetchResult } from './egress.ts';

/**
 * The in-isolate response cache used by {@link createEgressClient}.
 *
 * It is NOT durable — it only collapses duplicate requests handled by the same
 * warm isolate — but public-API responses are typically highly cacheable, so
 * repeats become instant and stay inside the upstream's fair-access rate. Only
 * 200s are cached.
 *
 * Bounded three ways, because an unbounded cache in a shared isolate is a memory
 * leak with good intentions: a TTL, an LRU entry count, and a size cap both per
 * entry and (optionally) in total.
 *
 * @module
 */

export interface CacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxEntryBytes: number;
  /** Optional bound on the sum of cached body sizes. */
  maxTotalBytes?: number;
}

interface CacheEntry {
  at: number;
  value: FetchResult;
}

export interface ResponseCache {
  get(key: string): FetchResult | undefined;
  set(key: string, value: FetchResult): void;
}

/** A cache that stores nothing — what a client without `cache` options gets. */
const NO_CACHE: ResponseCache = {
  get: () => undefined,
  set: () => undefined,
};

/**
 * Build the response cache for one egress client.
 *
 * @param options - The size and TTL bounds, or undefined for no caching.
 * @returns The cache (a no-op cache when options are absent).
 */
export function createResponseCache(options: CacheOptions | undefined): ResponseCache {
  if (!options) return NO_CACHE;

  const entries = new Map<string, CacheEntry>();
  let totalBytes = 0;

  function remove(key: string): void {
    const hit = entries.get(key);
    if (!hit) return;
    totalBytes -= hit.value.body.length;
    entries.delete(key);
  }

  return {
    get(key: string): FetchResult | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > options.ttlMs) {
        remove(key);
        return undefined;
      }
      // Refresh recency — a Map preserves insertion order, so the oldest key is
      // the one evicted first.
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },

    set(key: string, value: FetchResult): void {
      if (value.body.length > options.maxEntryBytes) return;
      remove(key);
      entries.set(key, { at: Date.now(), value });
      totalBytes += value.body.length;

      const maxTotal = options.maxTotalBytes ?? Number.POSITIVE_INFINITY;
      while (entries.size > options.maxEntries || (totalBytes > maxTotal && entries.size > 1)) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
    },
  };
}
