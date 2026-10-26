import { describe, expect, it } from 'vitest';
import { telegramWebhookSecret } from './telegram-bot';

describe('the shared Telegram bot', () => {
  it('derives the webhook secret from the token, the same every time and different per token', () => {
    const a = telegramWebhookSecret('123:AAA');
    expect(a).toBe(telegramWebhookSecret('123:AAA'));
    expect(a).not.toBe(telegramWebhookSecret('123:AAB'));
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(a).not.toContain('123:AAA');
  });
});
