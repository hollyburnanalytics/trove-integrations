# X Bookmarks — developer notes

Implementation details that don't belong in the catalog description.

- Reads `GET /2/users/:id/bookmarks` (your ~800 most recent, newest-first) via
  OAuth 2.0 user-context with the `bookmark.read` scope.
- Reads three credentials from `ctx.credentials`: `X_OAUTH_CLIENT_ID`,
  `X_OAUTH_REFRESH_TOKEN`, and (for a confidential client) the optional
  `X_OAUTH_CLIENT_SECRET`.
- Marked `available: false` because it needs a one-time OAuth authorize step
  (`scripts/x-authorize.mjs`) plus rotating-refresh-token management we can't
  collect through the app yet.
