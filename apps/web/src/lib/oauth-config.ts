/**
 * This host's OAuth client identity.
 *
 * One definition, used by both halves of CIMD: the document served at
 * `/.well-known/mcp-client-metadata.json`, and the provider that presents that
 * URL as its `client_id`. If the two could drift, an authorization server would
 * read one identity and be handed another.
 */
import type { OAuthClientConfig } from '@salvations/mcp';
import { env } from './env';

/** Where the client metadata document lives. This string IS the client_id. */
export const CLIENT_METADATA_PATH = '/.well-known/mcp-client-metadata.json';

/** Where an authorization server sends a person back after consent. */
export const OAUTH_CALLBACK_PATH = '/api/mcp/callback';

export function oauthClientConfig(): OAuthClientConfig {
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');

  return {
    // CIMD requires an HTTPS URL. On localhost there is none to serve, so the
    // metadata URL is omitted and the SDK falls back to registration — which is
    // the right behaviour for development and must never be the production one.
    ...(base.startsWith('https://')
      ? { clientMetadataUrl: `${base}${CLIENT_METADATA_PATH}` }
      : {}),
    redirectUri: `${base}${OAUTH_CALLBACK_PATH}`,
    clientName: 'Salvations',
    clientUri: base,
  };
}
