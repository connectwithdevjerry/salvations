/**
 * WhatsApp in one press: Meta's Embedded Signup, with this deployment's own
 * Meta app.
 *
 * Meta's flow differs from Slack's and Discord's: there is no redirect.
 * Meta's JavaScript SDK opens a window in which the person picks or
 * creates their WhatsApp Business account and number, and then posts two
 * things back to the page that opened it: a message event naming the
 * phone number id and the Messaging account id, and a code good for thirty
 * seconds. The page sends all three here at once. This file redeems the
 * code for the business token, subscribes the app to that account's
 * webhooks, and registers the number for the Cloud API, which is what
 * Meta's onboarding guide for Tech Providers says to do, in that order.
 *
 * Deliveries for every such number then arrive at one shared address,
 * signed with the app secret, and the phone number id inside each one is
 * what routes it. The verify token Meta echoes on its probe is whatever the
 * deployment chose, or one derived from the app secret when it chose none.
 *
 * Checked against Meta's documentation: FB.login with `config_id`,
 * `response_type: 'code'` and `override_default_response_type: true`; the
 * `WA_EMBEDDED_SIGNUP` message event; GET /oauth/access_token with
 * client_id, client_secret and code; POST /<WABA_ID>/subscribed_apps;
 * POST /<PHONE_NUMBER_ID>/register with a six-digit pin. The page's domain
 * must be among the app's Allowed Domains and Valid OAuth Redirect URIs.
 */
import { timingSafeEqual, randomInt } from 'node:crypto';
import { GRAPH_VERSION, whatsappVerifyToken } from '@salvations/channels';
import { env } from './env';
import { issuer } from './session';

export const WHATSAPP_APP_PATH = '/api/channels/whatsapp/app';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface WhatsAppSignup {
  readonly appId: string;
  readonly appSecret: string;
  /** The Facebook Login for Business configuration with Embedded Signup on it. */
  readonly configId: string;
  readonly verifyToken: string;
}

/** The deployment's Embedded Signup, or undefined when the Meta app has no configuration for it. */
export function whatsappSignup(): WhatsAppSignup | undefined {
  const e = env();
  if (e.META_APP_ID === undefined || e.META_APP_SECRET === undefined || e.META_WHATSAPP_CONFIG_ID === undefined) return undefined;
  return {
    appId: e.META_APP_ID,
    appSecret: e.META_APP_SECRET,
    configId: e.META_WHATSAPP_CONFIG_ID,
    verifyToken: e.META_WHATSAPP_VERIFY_TOKEN ?? whatsappVerifyToken({ webhookUrl: '', webhookSecret: e.META_APP_SECRET }),
  };
}

export const whatsappAppWebhookUrl = (): string => `${issuer()}${WHATSAPP_APP_PATH}`;

/** What the browser needs to open Meta's window. Nothing secret. */
export const whatsappSignupPublic = (signup: WhatsAppSignup): { appId: string; configId: string; version: string } =>
  ({ appId: signup.appId, configId: signup.configId, version: GRAPH_VERSION });

/**
 * Meta's probe before it saves the shared callback URL: the challenge is
 * echoed when the verify token matches, and nothing is said otherwise.
 */
export function answerSharedProbe(signup: WhatsAppSignup, query: URLSearchParams): string | undefined {
  const presented = query.get('hub.verify_token');
  const challenge = query.get('hub.challenge');
  if (query.get('hub.mode') !== 'subscribe' || presented === null || challenge === null) return undefined;
  const expected = Buffer.from(signup.verifyToken);
  const given = Buffer.from(presented);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  return challenge;
}

interface GraphError { error?: { message?: string; code?: number; error_subcode?: number } }

const SIGNUP_ERRORS: Readonly<Record<number, string>> = {
  100: 'Meta did not accept the code. It lasts thirty seconds; press the button again.',
  190: 'Meta rejected this deployment\'s app credentials. Check META_APP_ID and META_APP_SECRET.',
  10: 'Meta says this app may not do that yet: while the app is in development mode only its admins and testers can connect, and onboarding other businesses needs App Review for whatsapp_business_management and whatsapp_business_messaging.',
  200: 'Meta says this account may not be connected: the person needs to administer the WhatsApp Business account.',
};

async function graph<T>(fetchImpl: typeof fetch, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  let response: Response;
  try {
    response = await fetchImpl(`${GRAPH}${path}`, {
      ...rest,
      headers: {
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...rest.headers,
      },
    });
  } catch (caught) {
    throw new Error(`Could not reach Meta: ${String(caught)}`, { cause: caught });
  }
  const body = await response.json().catch(() => undefined) as (T & GraphError) | undefined;
  if (!response.ok || body?.error !== undefined) {
    const code = body?.error?.code;
    const known = code !== undefined ? SIGNUP_ERRORS[code] : undefined;
    throw new Error(known ?? `Meta refused the request (${response.status}). ${body?.error?.message ?? ''}`.trim());
  }
  return body as T;
}

/** The code Meta's window posted back, redeemed for the account's business token. No redirect URI: Embedded Signup has none. */
export async function exchangeSignupCode(signup: WhatsAppSignup, code: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const search = new URLSearchParams({ client_id: signup.appId, client_secret: signup.appSecret, code });
  const answer = await graph<{ access_token?: string }>(fetchImpl, `/oauth/access_token?${search}`);
  if (typeof answer.access_token !== 'string') throw new Error('Meta answered without a token.');
  return answer.access_token;
}

export interface SignupAssets { readonly phoneNumberId: string; readonly wabaId: string }

/**
 * Which account and number the token was granted for, when the browser did
 * not say. Meta's debug_token names the Messaging accounts the person
 * shared under the whatsapp_business_management scope; the first number on
 * the first of them is taken.
 */
export async function discoverSignupAssets(signup: WhatsAppSignup, token: string, fetchImpl: typeof fetch = fetch): Promise<SignupAssets> {
  const search = new URLSearchParams({ input_token: token, access_token: `${signup.appId}|${signup.appSecret}` });
  const debug = await graph<{ data?: { granular_scopes?: { scope?: string; target_ids?: string[] }[] } }>(fetchImpl, `/debug_token?${search}`);
  const wabaId = debug.data?.granular_scopes?.find((s) => s.scope === 'whatsapp_business_management')?.target_ids?.[0];
  if (wabaId === undefined) throw new Error('Meta did not say which WhatsApp Business account was shared. Press the button again and pick an account.');
  const numbers = await graph<{ data?: { id?: string }[] }>(fetchImpl, `/${wabaId}/phone_numbers`, { token });
  const phoneNumberId = numbers.data?.[0]?.id;
  if (phoneNumberId === undefined) throw new Error('That WhatsApp Business account has no phone number yet. Add one in Meta Business Suite and press the button again.');
  return { phoneNumberId, wabaId };
}

/** Tells Meta to deliver this account's messages to the app. */
export async function subscribeAccount(token: string, wabaId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await graph(fetchImpl, `/${wabaId}/subscribed_apps`, { method: 'POST', token });
}

/** A six-digit two-step verification pin, as Meta requires for registration. */
export const newRegistrationPin = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Registers the number for the Cloud API. Needed once before it can send. */
export async function registerNumber(token: string, phoneNumberId: string, pin: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await graph(fetchImpl, `/${phoneNumberId}/register`, {
    method: 'POST', token, body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  });
}
