/**
 * The CIMD client metadata document (SEP-991).
 *
 * Its URL is this host's `client_id`, so every authorization server a workspace
 * connects to fetches this. That makes it public by definition: it carries this
 * client's identity and nothing else — no secret, no workspace, no user.
 *
 * It must stay reachable and stable. An authorization server that cannot fetch
 * it rejects the client, and a URL that changes invalidates every grant already
 * issued to the old one.
 */
import { clientMetadataDocument } from '@salvations/mcp';
import { oauthClientConfig } from '@/lib/oauth-config';

export const runtime = 'nodejs';
// Static for the life of a deployment: the values come from configuration, not
// from a request.
export const dynamic = 'force-static';

export function GET(): Response {
  const config = oauthClientConfig();

  if (config.clientMetadataUrl === undefined) {
    // Development over plain HTTP. Serving a document whose client_id is not an
    // HTTPS URL would be rejected anyway, and pretending otherwise hides the
    // reason.
    return Response.json(
      {
        error: 'not_configured',
        error_description:
          'Client ID Metadata requires an HTTPS PUBLIC_BASE_URL. This deployment has none, ' +
          'so servers fall back to dynamic client registration.',
      },
      { status: 404 },
    );
  }

  return Response.json(clientMetadataDocument(config), {
    headers: {
      // Fetched by third parties on every unregistered flow; a short cache
      // keeps a rotation visible within the hour.
      'cache-control': 'public, max-age=3600',
      'content-type': 'application/json',
    },
  });
}
