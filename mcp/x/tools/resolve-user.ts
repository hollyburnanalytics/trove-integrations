import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { USER_FIELDS_PROFILE } from '../client.ts';
import { costNote } from '../cost.ts';
import { profileShape } from '../shapes.ts';
import { snippet } from '../tweets.ts';
import { cleanUsername, mapProfile, resolveUser } from '../users.ts';

/**
 * `resolve_user` — look up an X profile by @handle (id, bio, follower counts,
 * verified flag, and more) for a single user read.
 */
export const resolveUserTool: ToolDefinition = {
  name: 'resolve_user',
  title: 'X: Resolve a handle to a profile',
  description:
    'Look up an X profile by @handle: id, display name, bio, follower/following/' +
    'post counts, verified flag, account creation date, location, and avatar URL. ' +
    'Useful before get_user_tweets, or to vet an account. Cost: $0.010 (one user read).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    username: z.string().min(1).describe('X handle, with or without a leading @.'),
  }),
  output: profileShape.extend({ note: z.string() }),
  async handler(args, ctx) {
    const username = cleanUsername(args.username);
    if (!username) throw new ToolError('Provide a non-empty username.', { retryable: false });
    ctx.log('resolve_user', { username });
    const raw = await resolveUser(username, USER_FIELDS_PROFILE, ctx);
    const profile = mapProfile(raw);
    const note = costNote(0, 1);
    const counts =
      profile.followers !== null
        ? ` · ${profile.followers} followers, ${profile.tweetCount ?? '?'} posts`
        : '';
    return {
      text:
        `${profile.name ?? username} (@${profile.username ?? username})` +
        `${profile.verified ? ' ✓' : ''}${counts}` +
        `${profile.bio ? `\n  ${snippet(profile.bio)}` : ''}\n${note}`,
      structured: { ...profile, note },
    };
  },
};
