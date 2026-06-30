import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const API_KEY = 're_test_key_123';
const RECIPIENT = 'owner@example.com';

/**
 * Build a fetch responder that satisfies both secret lookups
 * (RESEND_API_KEY, RECIPIENT_EMAIL) and answers the `POST /emails` call with
 * `emailSpec`. Optionally records the captured `POST /emails` init.
 */
function resendResponder(emailSpec, capture) {
  return (url, init) => {
    if (url.includes('/internal/secret')) {
      const name = JSON.parse(init.body).name;
      const value = name === 'RECIPIENT_EMAIL' ? RECIPIENT : API_KEY;
      return { json: { value } };
    }
    if (capture) capture(url, init);
    return emailSpec;
  };
}

describe('resend MCP server', () => {
  it('exposes the send_email tool', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['send_email']);
  });

  describe('send_email', () => {
    it('sends an email and returns the Resend message id', async () => {
      let captured;
      const result = await callTool(
        server,
        'send_email',
        { subject: 'Daily digest', text: 'Hello from your routine.' },
        resendResponder({ json: { id: 'msg_abc123' } }, (url, init) => {
          captured = { url, init };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured).toEqual({
        sent: true,
        id: 'msg_abc123',
        to: RECIPIENT,
        subject: 'Daily digest',
      });
      expect(result.result.text).toContain(RECIPIENT);
      expect(result.result.text).toContain('msg_abc123');

      // The upstream call hits POST /emails with the fixed recipient and default sender.
      expect(captured.url).toBe('https://api.resend.com/emails');
      expect(captured.init.method).toBe('POST');
      const payload = JSON.parse(captured.init.body);
      expect(payload.to).toEqual([RECIPIENT]);
      expect(payload.from).toBe('Trove <onboarding@resend.dev>');
      expect(payload.subject).toBe('Daily digest');
      expect(payload.text).toBe('Hello from your routine.');
      expect(payload.html).toBeUndefined();
    });

    it('passes a custom from/replyTo and html body through to Resend', async () => {
      let captured;
      const result = await callTool(
        server,
        'send_email',
        {
          subject: 'Hi',
          html: '<p>Hi</p>',
          from: 'You <you@yourdomain.com>',
          replyTo: 'reply@yourdomain.com',
        },
        resendResponder({ json: { id: 'msg_xyz' } }, (url, init) => {
          captured = { url, init };
        }),
      );
      expect(result.ok).toBe(true);
      const payload = JSON.parse(captured.init.body);
      expect(payload.from).toBe('You <you@yourdomain.com>');
      expect(payload.reply_to).toBe('reply@yourdomain.com');
      expect(payload.html).toBe('<p>Hi</p>');
      expect(payload.text).toBeUndefined();
    });

    it('tolerates a response with no id (id → null, sent still true)', async () => {
      const result = await callTool(
        server,
        'send_email',
        { subject: 'No id', text: 'body' },
        resendResponder({ json: {} }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.sent).toBe(true);
      expect(result.result.structured.id).toBeNull();
      // The "(id ...)" suffix is omitted when there is no id.
      expect(result.result.text).not.toContain('(id');
    });

    it('rejects a body with neither text nor html (no fetch)', async () => {
      const result = await callTool(server, 'send_email', { subject: 'Empty' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/text and\/or html/i);
    });

    it('maps a 422 to a non-retryable error carrying the Resend reason', async () => {
      const result = await callTool(
        server,
        'send_email',
        { subject: 'Bad', text: 'body' },
        resendResponder({ status: 422, json: { message: 'Invalid `to` field.' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/Invalid `to` field/);
    });

    it('maps a 401 to a non-retryable API-key error', async () => {
      const result = await callTool(
        server,
        'send_email',
        { subject: 'Bad key', text: 'body' },
        resendResponder({ status: 401, json: { message: 'API key is invalid' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/RESEND_API_KEY/);
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'send_email',
        { subject: 'Boom', text: 'body' },
        resendResponder({ status: 500, text: 'oops' }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a missing subject before fetching', async () => {
      const result = await callTool(server, 'send_email', { text: 'body' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty subject before fetching', async () => {
      const result = await callTool(server, 'send_email', { subject: '', text: 'body' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects a malformed from address before fetching', async () => {
      const result = await callTool(server, 'send_email', {
        subject: 'Hi',
        text: 'body',
        from: 'not-an-email',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
