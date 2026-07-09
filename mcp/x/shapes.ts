import { z } from '@ontrove/mcp';

/**
 * Shared zod output schemas for the x tools: the clean tweet shape (with its
 * optional joined media) and the resolved-profile shape. Reused across tools so
 * every `structured` payload validates against the same contract.
 */

export const tweetShape = z.object({
  id: z.string(),
  text: z.string(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string().nullable(),
  likes: z.number().nullable(),
  reposts: z.number().nullable(),
  replies: z.number().nullable(),
  quotes: z.number().nullable(),
  media: z
    .array(z.object({ type: z.string(), url: z.string().optional(), alt: z.string().optional() }))
    .optional(),
});

export const profileShape = z.object({
  id: z.string(),
  name: z.string().nullable(),
  username: z.string().nullable(),
  url: z.string().nullable(),
  bio: z.string().nullable(),
  followers: z.number().nullable(),
  following: z.number().nullable(),
  tweetCount: z.number().nullable(),
  verified: z.boolean().nullable(),
  createdAt: z.string().nullable(),
  location: z.string().nullable(),
  profileImageUrl: z.string().nullable(),
});
