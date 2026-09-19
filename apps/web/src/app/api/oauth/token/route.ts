/**
 * RFC 6749 §3.2 token endpoint, for public clients with PKCE.
 *
 * Two grants: a code becomes a token pair once, and a refresh token becomes a
 * new pair once. The repository holds the "once"; this file holds the wire
 * shape and the error vocabulary the specification fixes.
 */
import { OAuthServerRepository, type GrantFailure } from '@salvations/db';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

const HEADERS = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'access-control-allow-origin': '*',
};

const fail = (error: string, description: string, status = 400): Response =>
  Response.json({ error, error_description: description }, { status, headers: HEADERS });

const REASONS: Readonly<Record<GrantFailure, string>> = {
  invalid: 'The grant is not recognised.',
  expired: 'The grant has expired.',
  used: 'The grant was already used. Every token from it has been revoked.',
  client_mismatch: 'The grant belongs to another client.',
  redirect_mismatch: 'The redirect URI does not match the one the code was issued for.',
  pkce: 'The code verifier does not match the challenge.',
};

export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form === undefined) return fail('invalid_request', 'Send application/x-www-form-urlencoded.');

  const grantType = form.get('grant_type');
  const clientId = form.get('client_id');
  if (clientId === null || clientId === '') return fail('invalid_client', 'client_id is required.', 401);

  const handle = await db();
  const repo = new OAuthServerRepository(handle.db);
  if (await repo.findClient(clientId) === null) return fail('invalid_client', 'Unknown client.', 401);

  if (grantType === 'authorization_code') {
    const code = form.get('code');
    const redirectUri = form.get('redirect_uri');
    const verifier = form.get('code_verifier');
    if (code === null || redirectUri === null || verifier === null) {
      return fail('invalid_request', 'code, redirect_uri and code_verifier are required.');
    }
    // RFC 8707: a resource named here has to be the one the code was for.
    const resource = form.get('resource');
    const result = await repo.redeemCode(code, { clientId, redirectUri, codeVerifier: verifier });
    if (!result.ok) return fail('invalid_grant', REASONS[result.reason]);
    if (resource !== null && resource !== result.grant.resource) {
      return fail('invalid_target', 'The resource does not match the one authorised.');
    }
    return issued(result.tokens);
  }

  if (grantType === 'refresh_token') {
    const token = form.get('refresh_token');
    if (token === null) return fail('invalid_request', 'refresh_token is required.');
    const result = await repo.rotateRefreshToken(token, clientId);
    if (!result.ok) return fail('invalid_grant', REASONS[result.reason]);
    return issued(result.tokens);
  }

  return fail('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

const issued = (tokens: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }): Response =>
  Response.json({
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  }, { headers: HEADERS });

async function readForm(request: Request): Promise<URLSearchParams | undefined> {
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.startsWith('application/x-www-form-urlencoded')) return new URLSearchParams(await request.text());
    if (type.startsWith('application/json')) {
      const body = await request.json() as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) if (typeof v === 'string') params.set(k, v);
      return params;
    }
  } catch { return undefined; }
  return undefined;
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, mcp-protocol-version',
    },
  });
}
