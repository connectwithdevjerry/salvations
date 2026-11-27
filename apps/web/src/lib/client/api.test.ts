import { afterEach, describe, expect, it, vi } from 'vitest';

const shown = vi.hoisted(() => [] as { title: string; links?: readonly { href: string }[] }[]);
vi.mock('./toasts', () => ({ toast: (t: { title: string }) => { shown.push(t); } }));

import { api, ApiError } from './api';

const answer = (status: number, code: string, message: string) =>
  vi.fn(async () => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => { shown.length = 0; vi.unstubAllGlobals(); });

describe('refusals nobody would otherwise see', () => {
  it('announces an ended trial, pointing at the workspace\'s billing page, and still throws', async () => {
    vi.stubGlobal('fetch', answer(402, 'payment_required', 'Your free trial has ended. Choose a plan to keep going.'));
    await expect(api.get('/api/workspaces/wks_1/agents')).rejects.toBeInstanceOf(ApiError);
    expect(shown[0]?.title).toBe('Your free trial has ended');
    expect(shown[0]?.links?.[0]?.href).toBe('/w/wks_1/billing');
  });

  it('announces a spending limit', async () => {
    vi.stubGlobal('fetch', answer(429, 'budget_exhausted', 'Today\'s spend has reached the daily cap.'));
    await expect(api.post('/api/workspaces/wks_1/conversations/c/messages', {})).rejects.toBeInstanceOf(ApiError);
    expect(shown[0]?.title).toBe('A spending limit was reached');
  });

  it('says nothing for an ordinary refusal, which the page shows itself', async () => {
    vi.stubGlobal('fetch', answer(422, 'validation_failed', 'Name is required.'));
    await expect(api.post('/api/workspaces/wks_1/agents', {})).rejects.toBeInstanceOf(ApiError);
    expect(shown).toEqual([]);
  });

  it('announces a connection that does not answer at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api.get('/api/workspaces/wks_1/agents')).rejects.toThrow('Failed to fetch');
    expect(shown[0]?.title).toBe('Can’t reach YASHAYAH');
  });
});
