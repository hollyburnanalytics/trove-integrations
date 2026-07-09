/**
 * Post-type selection → X request parameters. Maps a caller's choice of
 * originals/reposts/replies onto the timeline endpoint's `exclude` param and
 * onto X search `is:`/`-is:` operators, so every tool filters post types the
 * same way.
 */

/** The post types a caller can choose to include on a read. */
export const POST_TYPES = ['posts', 'reposts', 'replies'] as const;
export type PostType = (typeof POST_TYPES)[number];

/**
 * Map an `include` selection to X's timeline `exclude` param. The
 * `/2/users/:id/tweets` endpoint can only DROP replies and retweets — it can
 * never drop originals — so 'posts' is implicit: any selection returns originals
 * PLUS the extra types chosen. Returns undefined when nothing is excluded.
 */
export function includeToExclude(include: readonly PostType[]): string | undefined {
  const parts: string[] = [];
  if (!include.includes('replies')) parts.push('replies');
  if (!include.includes('reposts')) parts.push('retweets');
  return parts.length > 0 ? parts.join(',') : undefined;
}

/**
 * Translate a `post_types` selection into X search operators. Replies/reposts not
 * selected are dropped with `-is:reply` / `-is:retweet`; when originals are NOT
 * selected, a positive requirement keeps only the chosen non-original type(s).
 * Returns '' when all three (or none) are selected — i.e. no filtering needed.
 */
function postTypeOperators(types: readonly PostType[]): string {
  if (types.length === 0 || types.length === POST_TYPES.length) return '';
  const parts: string[] = [];
  if (!types.includes('replies')) parts.push('-is:reply');
  if (!types.includes('reposts')) parts.push('-is:retweet');
  if (!types.includes('posts')) {
    const wantReplies = types.includes('replies');
    const wantReposts = types.includes('reposts');
    if (wantReplies && wantReposts) parts.push('(is:reply OR is:retweet)');
    else if (wantReplies) parts.push('is:reply');
    else if (wantReposts) parts.push('is:retweet');
  }
  return parts.join(' ');
}

/** Append post-type operators to a base query, if any types were given. */
export function applyPostTypes(query: string, types: readonly PostType[] | undefined): string {
  if (!types || types.length === 0) return query;
  const ops = postTypeOperators(types);
  return ops ? `${query} ${ops}` : query;
}
