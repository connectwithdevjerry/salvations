import { describe, expect, it } from 'vitest';
import {
  answerSharedProbe, discoverSignupAssets, exchangeSignupCode, newRegistrationPin, registerNumber, subscribeAccount, type WhatsAppSignup,
} from './whatsapp-signup';

const SIGNUP: WhatsAppSignup = { appId: '236484624622562', appSecret: 'shh', configId: 'cfg_1', verifyToken: 'verify-me' };

const fetchSeq = (answers: { status: number; body: unknown }[], seen: { url: string; init: RequestInit | undefined }[] = []): typeof fetch =>
  (async (url, init) => {
    seen.push({ url: String(url), init });
    const next = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

describe('WhatsApp Embedded Signup', () => {
  it('answers Meta\'s probe only with the right verify token', () => {
    expect(answerSharedProbe(SIGNUP, new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '42' }))).toBe('42');
    expect(answerSharedProbe(SIGNUP, new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '42' }))).toBeUndefined();
    expect(answerSharedProbe(SIGNUP, new URLSearchParams({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '42' }))).toBeUndefined();
  });

  it('redeems the code with the app credentials and no redirect', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const token = await exchangeSignupCode(SIGNUP, 'the-code', fetchSeq([{ status: 200, body: { access_token: 'biz-token' } }], seen));
    expect(token).toBe('biz-token');
    const url = new URL(seen[0]?.url ?? '');
    expect(url.pathname).toMatch(/\/oauth\/access_token$/);
    expect(url.searchParams.get('client_id')).toBe('236484624622562');
    expect(url.searchParams.get('client_secret')).toBe('shh');
    expect(url.searchParams.get('code')).toBe('the-code');
    expect(url.searchParams.has('redirect_uri')).toBe(false);
  });

  it('finds the shared account and its number when the browser did not say', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const assets = await discoverSignupAssets(SIGNUP, 'biz-token', fetchSeq([
      { status: 200, body: { data: { granular_scopes: [{ scope: 'whatsapp_business_messaging' }, { scope: 'whatsapp_business_management', target_ids: ['WABA_1'] }] } } },
      { status: 200, body: { data: [{ id: 'PHONE_1', display_phone_number: '+1 555 0100' }] } },
    ], seen));
    expect(assets).toEqual({ phoneNumberId: 'PHONE_1', wabaId: 'WABA_1' });
    expect(new URL(seen[0]?.url ?? '').searchParams.get('access_token')).toBe('236484624622562|shh');
    expect(seen[1]?.url).toMatch(/\/WABA_1\/phone_numbers$/);
  });

  it('subscribes the account and registers the number with a six-digit pin', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = fetchSeq([{ status: 200, body: { success: true } }, { status: 200, body: { success: true } }], seen);
    await subscribeAccount('biz-token', 'WABA_1', fetchImpl);
    const pin = newRegistrationPin();
    expect(pin).toMatch(/^\d{6}$/);
    await registerNumber('biz-token', 'PHONE_1', pin, fetchImpl);
    expect(seen[0]?.url).toMatch(/\/WABA_1\/subscribed_apps$/);
    expect(seen[0]?.init?.method).toBe('POST');
    expect((seen[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer biz-token');
    expect(seen[1]?.url).toMatch(/\/PHONE_1\/register$/);
    expect(JSON.parse(String(seen[1]?.init?.body))).toEqual({ messaging_product: 'whatsapp', pin });
  });

  it('says what Meta refused in words a person can act on', async () => {
    await expect(exchangeSignupCode(SIGNUP, 'c', fetchSeq([{ status: 400, body: { error: { code: 100, message: 'bad code' } } }])))
      .rejects.toThrow(/thirty seconds/);
    await expect(discoverSignupAssets(SIGNUP, 't', fetchSeq([{ status: 200, body: { data: { granular_scopes: [] } } }])))
      .rejects.toThrow(/which WhatsApp Business account/);
  });
});
