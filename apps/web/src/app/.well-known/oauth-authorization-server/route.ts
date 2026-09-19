/**
 * RFC 8414: what this authorization server is and where its endpoints are.
 * Public by definition. Rendered per request because the issuer is the
 * deployment's own URL.
 */
import { authorizationServerMetadata } from '@/lib/oauth-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(authorizationServerMetadata(), {
    headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
  });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-protocol-version',
};
