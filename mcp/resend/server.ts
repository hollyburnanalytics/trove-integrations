import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * Resend — a hosted MCP server that **sends email** via the Resend API
 * (api.resend.com). This is the fleet's first mutating server: `send_email`
 * has a real side effect, so it is annotated `readOnlyHint: false` and the host
 * applies send-time confirmation.
 *
 * The motivating use case is letting an automated agent email the user — e.g. a
 * scheduled daily digest — in settings where only remote/hosted MCP servers are
 * reachable (not a local stdio MCP). The recipient is
 * **fixed to the owner's `RECIPIENT_EMAIL` secret** and CC/BCC are not allowed,
 * so this tool can only ever email that one address — it can't be steered into
 * sending to arbitrary recipients. Sending there needs no domain setup: Resend's
 * shared `onboarding@resend.dev` sender delivers immediately. To send from your
 * own domain (`you@example.com`), verify a domain in Resend and pass `from`.
 *
 * Two secrets, redeemed at call time via `ctx.requireSecret` (never bundled/logged):
 *   - `RESEND_API_KEY` — a free Resend API key.
 *   - `RECIPIENT_EMAIL` — the fixed recipient (e.g. `you@example.com`).
 * Set them with `trove secret set resend RESEND_API_KEY --from-stdin` and
 * `trove secret set resend RECIPIENT_EMAIL <address>`.
 */

/** Resend API base. */
const BASE_URL = 'https://api.resend.com';

/** Default sender — Resend's shared address, deliverable to the owner without a verified domain. */
const DEFAULT_FROM = 'Trove <onboarding@resend.dev>';

/** Bare email address shape (no display name). */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Accept a bare address (`you@example.com`) or an RFC-5322 display form
 * (`Name <you@example.com>`). Rejecting malformed sender/reply-to values keeps a
 * model from injecting header-spoofing junk into the owner's own inbox.
 */
function isValidAddress(value: string): boolean {
  const match = value.match(/<([^>]+)>\s*$/);
  return EMAIL_RE.test((match?.[1] ?? value).trim());
}

/** A successful `POST /emails` response (lenient). */
const SendResponse = z.object({ id: z.string().nullish() });

export default defineMcpServer({
  tools: [
    {
      name: 'send_email',
      title: 'Resend: Send an email',
      description:
        "Send an email to the owner's configured address (the RECIPIENT_EMAIL secret) via " +
        'Resend. Designed for automated digests/notifications to the owner — e.g. a daily digest. The ' +
        'recipient is fixed (you cannot send to anyone else, and CC/BCC are not supported). ' +
        'Provide a subject and a text and/or HTML body. Returns the Resend message id.',
      mutating: true,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      input: z.object({
        subject: z.string().min(1).describe('Email subject line.'),
        text: z.string().optional().describe('Plain-text body. Provide text and/or html.'),
        html: z.string().optional().describe('HTML body. Provide text and/or html.'),
        from: z
          .string()
          .refine(isValidAddress, 'from must be an email or "Name <email>"')
          .optional()
          .describe(
            'Sender, e.g. "You <you@yourdomain.com>". Defaults to Resend\'s shared sender.',
          ),
        replyTo: z
          .string()
          .refine(isValidAddress, 'replyTo must be an email or "Name <email>"')
          .optional()
          .describe('Reply-To address.'),
      }),
      output: z.object({
        sent: z.boolean(),
        id: z.string().nullable(),
        to: z.string(),
        subject: z.string(),
      }),
      async handler(args, ctx) {
        const { subject, text, html, from, replyTo } = args;
        if (!text && !html) {
          throw new ToolError('Provide a text and/or html body.', { retryable: false });
        }
        const [key, to] = await Promise.all([
          ctx.requireSecret('RESEND_API_KEY'),
          ctx.requireSecret('RECIPIENT_EMAIL'),
        ]);
        ctx.log('send_email', { subject }); // recipient is fixed; body not logged

        const payload: Record<string, unknown> = {
          from: from ?? DEFAULT_FROM,
          to: [to],
          subject,
        };
        if (text) payload.text = text;
        if (html) payload.html = html;
        if (replyTo) payload.reply_to = replyTo;

        const body = await ctx.fetchJson(`${BASE_URL}/emails`, {
          schema: SendResponse,
          init: {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          },
          errorMap: (res, raw) => {
            let reason = '';
            try {
              const j = JSON.parse(raw) as { message?: unknown };
              if (typeof j.message === 'string') reason = j.message;
            } catch {
              reason = raw.slice(0, 160);
            }
            if (res.status === 401 || res.status === 403) {
              return new ToolError('Resend rejected the API key (check RESEND_API_KEY).', {
                retryable: false,
              });
            }
            if (res.status === 422 || res.status === 400) {
              return new ToolError(`Resend rejected the email: ${reason || 'invalid request'}.`, {
                retryable: false,
              });
            }
            return undefined; // 429/5xx → SDK default (retryable)
          },
        });

        const id = body.id ?? null;
        return {
          text: `Sent email to ${to} — "${subject}"${id ? ` (id ${id})` : ''}.`,
          structured: { sent: true, id, to, subject },
        };
      },
    },
  ],
});
