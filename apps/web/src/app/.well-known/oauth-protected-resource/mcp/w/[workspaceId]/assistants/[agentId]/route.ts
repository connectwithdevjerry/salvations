/**
 * RFC 9728: the metadata for one assistant as a protected resource. Its URL
 * is the resource's own path under the well-known prefix, which is where the
 * challenge header sends a client.
 */
import { protectedResourceMetadata } from '@/lib/oauth-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ workspaceId: string; agentId: string }> };

export async function GET(_request: Request, context: Params): Promise<Response> {
  const { workspaceId, agentId } = await context.params;
  // No existence check: the document says how to authenticate, not whether
  // there is anything behind it, and confirming ids would help enumeration.
  return Response.json(protectedResourceMetadata(workspaceId, agentId), {
    headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
  });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type, mcp-protocol-version',
    },
  });
}
