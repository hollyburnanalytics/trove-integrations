/**
 * X (Twitter) — a hosted, read-only MCP server over the official X API v2
 * (api.x.com). Seven read surfaces:
 *  - `get_user_tweets`  — a person's recent posts (handle → id → timeline),
 *                         choose originals/reposts/replies via `include`,
 *  - `get_tweet`        — expand one post (by id or x.com URL) + its quoted/
 *                         replied-to context,
 *  - `get_post_replies` — the reply thread under a post (conversation_id → search),
 *  - `search_posts`     — search over X's operators, recent (last 7 days) OR the
 *                         full archive back to 2006 via a `scope` knob; filter by
 *                         post type via `post_types`,
 *  - `count_posts`      — how many posts match a query, WITHOUT reading them
 *                         (recent OR full archive via `scope`) — price a search
 *                         before you pull it,
 *  - `resolve_user`     — handle → profile (bio, follower counts, verified), and
 *  - `get_bookmarks`    — your own most-recent bookmarks (user-context OAuth).
 *
 * The six app-only read tools use a static, app-only **Bearer Token** (read-only,
 * long-lived) issued in the X developer portal — NOT an OAuth dance. It is
 * redeemed at call time via `ctx.requireSecret('X_BEARER_TOKEN')` (never bundled
 * or logged) and attached as `Authorization: Bearer <token>`. Set it with
 * `trove secret set x X_BEARER_TOKEN <token>`.
 *
 * `get_bookmarks` is different: `GET /2/users/:id/bookmarks` requires OAuth 2.0
 * **user-context** with the `bookmark.read` scope, which the app-only Bearer
 * cannot satisfy. It runs the refresh-token grant against
 * `POST /2/oauth2/token` using `X_OAUTH_CLIENT_ID` (+ optional
 * `X_OAUTH_CLIENT_SECRET` as HTTP Basic for a confidential client) and
 * `X_OAUTH_REFRESH_TOKEN`. Access tokens last ~2h and refresh tokens ROTATE
 * (each refresh returns a new one), so the freshly minted access token + rotated
 * refresh token are held in a module-level cache for the life of the warm
 * isolate. Obtain the first refresh token with `scripts/x-authorize.mjs`.
 *
 * Cost: X meters every read per its official pay-per-use pricing
 * (https://docs.x.com/x-api/getting-started/pricing): $0.005 per post read,
 * $0.010 per user lookup (e.g. resolving a handle), and a discounted $0.001
 * "owned read" for your OWN data via user-context — which is what `get_bookmarks`
 * uses (GET /2/users/:id/bookmarks on your own id). `count_posts` is a flat
 * per-request fee ($0.005 recent / $0.010 full archive) and returns how many
 * posts match a query WITHOUT reading them, so you can price a
 * `search_posts`/`get_user_tweets` pull first. Reads are
 * DEDUPLICATED within a UTC day: re-reading the same resource (e.g. when paging
 * overlaps) inside 24h is free. Each tool states its cost in its description and
 * reports the actual per-call spend in its `note` field.
 */
import { defineMcpServer } from '@ontrove/mcp';
import { countPosts } from './tools/count-posts.ts';
import { getBookmarks } from './tools/get-bookmarks.ts';
import { getPostReplies } from './tools/get-post-replies.ts';
import { getTweet } from './tools/get-tweet.ts';
import { getUserTweets } from './tools/get-user-tweets.ts';
import { resolveUserTool } from './tools/resolve-user.ts';
import { searchPosts } from './tools/search-posts.ts';

// Re-export the module-level cache reset seams the server test drives directly.
export { __resetBookmarkAuth } from './auth.ts';
export { __resetUserCache } from './users.ts';

export default defineMcpServer({
  tools: [
    getUserTweets,
    getTweet,
    getPostReplies,
    searchPosts,
    countPosts,
    resolveUserTool,
    getBookmarks,
  ],
});
