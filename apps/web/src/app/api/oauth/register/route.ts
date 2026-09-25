/**
 * RFC 7591 dynamic client registration.
 *
 * Open, as the MCP specification expects: a client the platform has never
 * heard of can register itself before sending a person to consent. What a
 * registration buys is only a name and a set of redirect URIs — the person
 * still signs in and still says yes on a page that shows that name.
 */
import { z } from 'zod';
import { OAuthServerRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { isAcceptableRedirectUri } from '@/lib/oauth-server';

export const runtime = 'nodejs';

const registration = z.object({
  client_name: z.string().trim().min(1).max(120).optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
  client_uri: z.string().url().max(2048).optional(),
  logo_uri: z.string().url().max(2048).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
}).passthrough();

const fail = (error: string, description: string, status = 400): Response =>
  Response.json({ error, error_description: description }, { status, headers: CORS });

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return fail('invalid_client_metadata', 'The body is not JSON.'); }

  const parsed = registration.safeParse(body);
  if (!parsed.success) return fail('invalid_client_metadata', 'The client metadata is not valid.');
  const input = parsed.data;

  const bad = input.redirect_uris.find((uri) => !isAcceptableRedirectUri(uri));
  if (bad !== undefined) {
    return fail('invalid_redirect_uri', `"${bad}" is not an acceptable redirect URI: use HTTPS, a loopback address, or a native app scheme.`);
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== 'none') {
    return fail('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported.');
  }

  const handle = await db();
  const client = await new OAuthServerRepository(handle.db).registerClient({
    name: input.client_name ?? new URL(input.redirect_uris[0] as string).hostname,
    redirectUris: input.redirect_uris,
    ...(input.client_uri !== undefined ? { clientUri: input.client_uri } : {}),
    ...(input.logo_uri !== undefined ? { logoUri: input.logo_uri } : {}),
  });

  return Response.json({
    client_id: client._id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...(client.clientUri !== null ? { client_uri: client.clientUri } : {}),
    ...(client.logoUri !== null ? { logo_uri: client.logoUri } : {}),
  }, { status: 201, headers: CORS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-protocol-version',
};
