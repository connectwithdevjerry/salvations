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

/**
 * The cookie that tells the callback which connection was being authorised.
 *
 * The authorization server returns only `code` and `state`; the state is
 * random by design, so it cannot carry the workspace. This cookie does,
 * scoped to the callback path alone. It names the connection; the state
 * check, against the pending record filed under that connection, is what
 * proves the response belongs to it.
 */
export const OAUTH_PENDING_COOKIE = 'hive_mcp_pending';

/** Long enough to read a consent screen; short enough not to outlive the PKCE record. */
export const OAUTH_PENDING_COOKIE_SECONDS = 10 * 60;

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
    clientName: 'HIVE',
    clientUri: base,
  };
}
