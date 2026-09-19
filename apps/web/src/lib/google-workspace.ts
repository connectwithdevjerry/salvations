/**
 * Google Workspace, directly.
 *
 * Google publishes no MCP server for Workspace, so the assistant reaches
 * Gmail, Calendar and Drive over Google's REST APIs with a token the person
 * granted on Google's own consent screen. Our OAuth client (the same one
 * behind "Sign in with Google") asks for offline access, so the refresh token
 * keeps the connection alive without anyone signing in again.
 *
 * Tokens live in the same encrypted store as the remote MCP servers' tokens,
 * under the binding's scope key, so revoking a connection is one row.
 */
import { pkceChallengeOf } from '@salvations/crypto';
import { scopeKeyString, workspaceScope, userScope } from '@salvations/mcp';
import {
  plainTextOfPayload, rawMessage,
  type CalendarEvent, type DriveFile, type GmailPayload, type GoogleWorkspaceSource, type MailLabel, type MailMessage, type MailSummary,
} from '@salvations/servers';
import { MongoOAuthCredentialStore, ScopedDb, type Database, type McpServerBindingDoc } from '@salvations/db';
import { randomBytes } from 'node:crypto';
import { catalogEntry } from '@salvations/catalog';
import { env } from './env';
import { issuer } from './session';
import { keyProvider } from './keys';
import { OAUTH_CALLBACK_PATH } from './oauth-config';

export const GOOGLE_WORKSPACE_ALIAS = 'google_workspace';
export const GOOGLE_ISSUER = 'https://accounts.google.com';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';

/** Refresh this long before the vendor's own expiry, so a call never lands on a dead token. */
const REFRESH_MARGIN_MS = 60_000;

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

export interface GoogleOAuthClient { readonly clientId: string; readonly clientSecret: string }

export function googleOAuthClient(): GoogleOAuthClient | undefined {
  const e = env();
  if (e.GOOGLE_CLIENT_ID === undefined || e.GOOGLE_CLIENT_SECRET === undefined) return undefined;
  return { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET };
}

export const googleRedirectUri = (): string => `${issuer()}${OAUTH_CALLBACK_PATH}`;

const scopesOf = (): string[] =>
  (catalogEntry('google_workspace')?.scopes ?? []).map((s) => s.scope);

/** Begins consent: the URL to send the person to, and what to remember until they are back. */
export function beginGoogleConsent(client: GoogleOAuthClient): {
  authorizationUrl: string; state: string; codeVerifier: string;
} {
  const state = randomBytes(24).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', googleRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopesOf().join(' '));
  // Offline: a refresh token, so the connection outlives the hour. Consent
  // every time: Google only hands out a refresh token when it shows the
  // screen, and a reconnect without one would silently produce a token that
  // dies in an hour.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkceChallengeOf(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { authorizationUrl: url.toString(), state, codeVerifier };
}

export async function exchangeGoogleCode(
  client: GoogleOAuthClient,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: client.clientId, client_secret: client.clientSecret,
      redirect_uri: googleRedirectUri(), grant_type: 'authorization_code', code_verifier: codeVerifier,
    }),
  });
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!response.ok || body.access_token === undefined) {
    throw new Error(`Google refused the code: ${body.error ?? response.status} ${body.error_description ?? ''}`.trim());
  }
  return {
    access_token: body.access_token,
    ...(body.refresh_token !== undefined ? { refresh_token: body.refresh_token } : {}),
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    ...(body.scope !== undefined ? { scope: body.scope } : {}),
  };
}

async function refreshGoogleToken(
  client: GoogleOAuthClient,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<StoredTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'refresh_token',
    }),
  });
  const body = await response.json() as { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!response.ok || body.access_token === undefined) {
    throw new Error(`Google refused to refresh the connection: ${body.error ?? response.status} ${body.error_description ?? ''}`.trim());
  }
  return {
    access_token: body.access_token,
    refresh_token: refreshToken,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    ...(body.scope !== undefined ? { scope: body.scope } : {}),
  };
}

/* ------------------------------------------------------------ the source -- */

export interface GoogleSourceInput {
  readonly database: Database;
  readonly workspaceId: string;
  readonly bindingId: string;
  /** Present when the binding is per person: whose tokens to use. */
  readonly userId?: string | undefined;
  readonly fetch?: typeof fetch;
}

/** The same encrypted store the remote servers' tokens live in, keyed by scope string. */
export const googleStore = (database: Database, workspaceId: string): MongoOAuthCredentialStore =>
  new MongoOAuthCredentialStore(database, workspaceId, keyProvider());

/** The scope key a binding's tokens are filed under. */
export async function googleScopeKeyFor(input: GoogleSourceInput): Promise<string> {
  const binding = await new ScopedDb(input.database, input.workspaceId)
    .collection<McpServerBindingDoc>('mcpServerBindings')
    .findOne({ _id: input.bindingId } as never);
  const perUser = binding?.perUserAuth === true && input.userId !== undefined;
  return scopeKeyString(perUser
    ? userScope(input.workspaceId, input.bindingId, input.userId as string)
    : workspaceScope(input.workspaceId, input.bindingId));
}

export function createGoogleSource(input: GoogleSourceInput): GoogleWorkspaceSource {
  const fetchImpl = input.fetch ?? fetch;
  const store = googleStore(input.database, input.workspaceId);
  let scopeKey: string | undefined;

  async function accessToken(): Promise<string> {
    scopeKey ??= await googleScopeKeyFor(input);
    const tokens = await store.loadTokens(scopeKey, GOOGLE_ISSUER) as StoredTokens | undefined;
    if (tokens === undefined) throw new Error('Google Workspace is not connected for this assistant. Connect it on the Integrations tab.');
    if (tokens.expires_at - REFRESH_MARGIN_MS > Date.now()) return tokens.access_token;
    if (tokens.refresh_token === undefined) throw new Error('The Google connection has expired and cannot be refreshed. Reconnect it on the Integrations tab.');
    const client = googleOAuthClient();
    if (client === undefined) throw new Error('This deployment has no Google client configured.');
    const fresh = await refreshGoogleToken(client, tokens.refresh_token, fetchImpl);
    await store.saveTokens(scopeKey, GOOGLE_ISSUER, fresh);
    return fresh.access_token;
  }

  async function google<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await accessToken();
    const response = await fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { /* plain */ }
      throw new Error(`Google answered ${response.status}: ${message.slice(0, 300)}`);
    }
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  const json = (body: unknown): RequestInit => ({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  /* gmail */

  interface GmailMessage {
    id: string; threadId: string; snippet?: string; labelIds?: string[];
    payload?: GmailPayload & { headers?: { name: string; value: string }[] };
  }

  const header = (m: GmailMessage, name: string): string =>
    m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  let labelNames: Map<string, string> | undefined;
  async function nameLabels(ids: readonly string[]): Promise<string[]> {
    if (labelNames === undefined) {
      const labels = await listLabels();
      labelNames = new Map(labels.map((l) => [l.id, l.name]));
    }
    return ids.map((id) => labelNames?.get(id) ?? id);
  }

  const summarise = async (m: GmailMessage): Promise<MailSummary> => ({
    id: m.id, threadId: m.threadId,
    from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: header(m, 'Date'),
    snippet: m.snippet ?? '',
    labels: await nameLabels(m.labelIds ?? []),
    unread: (m.labelIds ?? []).includes('UNREAD'),
  });

  async function listLabels(): Promise<MailLabel[]> {
    const result = await google<{ labels?: { id: string; name: string; type?: string }[] }>(`${GMAIL}/labels`);
    return (result.labels ?? []).map((l) => ({ id: l.id, name: l.name, system: l.type === 'system' }));
  }

  /* calendar */

  interface GEvent {
    id: string; summary?: string; location?: string; htmlLink?: string;
    start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
    attendees?: { email: string }[];
  }
  const toEvent = (e: GEvent): CalendarEvent => ({
    id: e.id, summary: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? '', end: e.end?.dateTime ?? e.end?.date ?? '',
    ...(e.location !== undefined ? { location: e.location } : {}),
    attendees: (e.attendees ?? []).map((a) => a.email),
    ...(e.htmlLink !== undefined ? { link: e.htmlLink } : {}),
  });

  /* drive */

  interface GFile { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }
  const toFile = (f: GFile): DriveFile => ({
    id: f.id, name: f.name, mimeType: f.mimeType, modified: f.modifiedTime ?? '',
    ...(f.webViewLink !== undefined ? { link: f.webViewLink } : {}),
  });
  const EXPORTS: Readonly<Record<string, string>> = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  };

  return {
    async searchMail(query, limit) {
      const list = await google<{ messages?: { id: string }[] }>(
        `${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(limit) })}`,
      );
      const ids = (list.messages ?? []).map((m) => m.id);
      const messages = await Promise.all(ids.map((id) =>
        google<GmailMessage>(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
      return Promise.all(messages.map(summarise));
    },

    async readMail(id): Promise<MailMessage | undefined> {
      let message: GmailMessage;
      try { message = await google<GmailMessage>(`${GMAIL}/messages/${id}?format=full`); } catch { return undefined; }
      const summary = await summarise(message);
      return { ...summary, text: plainTextOfPayload(message.payload, message.snippet) };
    },

    async sendMail(input) {
      let threadId: string | undefined;
      let inReplyTo: string | undefined;
      let references: string | undefined;
      if (input.replyToMessageId !== undefined) {
        const original = await google<GmailMessage>(
          `${GMAIL}/messages/${input.replyToMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
        );
        threadId = original.threadId;
        inReplyTo = header(original, 'Message-ID') || undefined;
        references = [header(original, 'References'), inReplyTo].filter((v) => v !== undefined && v !== '').join(' ') || undefined;
      }
      const raw = rawMessage({
        to: input.to, subject: input.subject, text: input.text,
        ...(input.cc !== undefined ? { cc: input.cc } : {}),
        ...(inReplyTo !== undefined ? { inReplyTo } : {}),
        ...(references !== undefined ? { references } : {}),
      });
      return google<{ id: string; threadId: string }>(`${GMAIL}/messages/send`, json({
        raw, ...(threadId !== undefined ? { threadId } : {}),
      }));
    },

    listLabels,

    async createLabel(name) {
      const created = await google<{ id: string; name: string }>(`${GMAIL}/labels`, json({
        name, labelListVisibility: 'labelShow', messageListVisibility: 'show',
      }));
      labelNames?.set(created.id, created.name);
      return { id: created.id, name: created.name, system: false };
    },

    async modifyLabels(ids, add, remove) {
      await google<undefined>(`${GMAIL}/messages/batchModify`, json({
        ids: [...ids], addLabelIds: [...add], removeLabelIds: [...remove],
      }));
      return ids.length;
    },

    async listEvents(input) {
      const params = new URLSearchParams({
        timeMin: input.from, timeMax: input.to, maxResults: String(input.limit),
        singleEvents: 'true', orderBy: 'startTime',
        ...(input.query !== undefined ? { q: input.query } : {}),
      });
      const result = await google<{ items?: GEvent[] }>(`${CALENDAR}/calendars/primary/events?${params}`);
      return (result.items ?? []).map(toEvent);
    },

    async createEvent(input) {
      const created = await google<GEvent>(`${CALENDAR}/calendars/primary/events?sendUpdates=all`, json({
        summary: input.summary,
        start: { dateTime: input.start }, end: { dateTime: input.end },
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.attendees !== undefined ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
      }));
      return toEvent(created);
    },

    async searchFiles(query, limit) {
      const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, '\\\'');
      const params = new URLSearchParams({
        q: `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`,
        pageSize: String(limit),
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
        orderBy: 'modifiedTime desc',
      });
      const result = await google<{ files?: GFile[] }>(`${DRIVE}/files?${params}`);
      return (result.files ?? []).map(toFile);
    },

    async readFile(id) {
      let meta: GFile;
      try {
        meta = await google<GFile>(`${DRIVE}/files/${id}?fields=id,name,mimeType,modifiedTime,webViewLink`);
      } catch { return undefined; }
      const exportAs = EXPORTS[meta.mimeType];
      const token = await accessToken();
      const url = exportAs !== undefined
        ? `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`
        : `${DRIVE}/files/${id}?alt=media`;
      if (exportAs === undefined && !/^text\/|json|xml|csv/.test(meta.mimeType)) return undefined;
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) return undefined;
      return { file: toFile(meta), text: await response.text() };
    },
  };
}
