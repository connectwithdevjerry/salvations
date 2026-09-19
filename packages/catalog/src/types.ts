/**
 * What an entry in the catalogue is.
 *
 * The catalogue is deliberately a hard-coded list. A generic "paste a URL"
 * box asks the person to know things only we can know — which scopes a service
 * needs, what its token looks like, which of its five auth flows applies — and
 * every one of those questions is a place to abandon setup. Naming the services
 * means we answer them in advance.
 *
 * This package holds descriptions, never behaviour: what a connection needs,
 * what it grants and how to explain it. The code that talks to a service lives
 * in its adapter, so this file stays readable as a list of promises we make.
 */

/** How the person proves the connection is theirs. */
export type SetupKind =
  /** A bot token pasted in, then a handshake that proves the bot answers. */
  | 'bot_token'
  /** A redirect to the service, consent, and a code exchanged server-side. */
  | 'oauth'
  /** An MCP server reached over HTTP, authorised by its own OAuth if it asks. */
  | 'mcp';

export type EntryKind = 'channel' | 'integration';

/** One instruction in a setup flow, in the order a person performs it. */
export interface SetupStep {
  readonly title: string;
  readonly body: string;
  /** A place the person has to go. Opened in a new tab, never navigated to. */
  readonly link?: { readonly label: string; readonly url: string };
  /** Something they type into a third-party app verbatim, shown as code. */
  readonly literal?: string;
}

/** A permission the connection grants, in the words the person needs. */
export interface GrantedScope {
  readonly label: string;
  /** The provider's own scope string, so the claim can be checked. */
  readonly scope: string;
  /** True when the grant can change or destroy something. */
  readonly writes: boolean;
}

export interface CatalogEntry {
  /** Stable. Stored on connection rows, so renaming one is a migration. */
  readonly id: string;
  readonly kind: EntryKind;
  readonly name: string;
  /** One line, in the list. Says what connecting gets you, not what it is. */
  readonly summary: string;
  readonly setup: SetupKind;
  /** The brand colour, used only for the entry's tile. */
  readonly accent: string;
  readonly steps: readonly SetupStep[];
  readonly scopes: readonly GrantedScope[];
  /**
   * Present when this deployment cannot offer the entry yet — missing
   * credentials, an unfinished adapter. Shown in place of the connect button,
   * because an offer that cannot be honoured is worse than no offer.
   */
  readonly unavailable?: string;
  /** Where to read more. Always the vendor's own documentation. */
  readonly docs?: string;
  /**
   * The vendor's hosted MCP server, for an `mcp` entry.
   *
   * Connecting installs a binding to this URL and sends the person to the
   * vendor's own consent screen; every tool the server offers is then the
   * agents' to call. Hard-coded so nobody has to find the URL in a docs page.
   */
  readonly mcp?: { readonly url: string };
  /**
   * Served by an adapter of ours, in this process, on the vendor's own REST
   * APIs — for a vendor that publishes no MCP server. Consent is the vendor's
   * consent screen; the tokens stay on our server, per assistant.
   */
  readonly native?: { readonly alias: string };
}

export const isChannel = (entry: CatalogEntry): boolean => entry.kind === 'channel';
export const isIntegration = (entry: CatalogEntry): boolean => entry.kind === 'integration';
