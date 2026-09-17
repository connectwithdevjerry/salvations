/**
 * Branded identifiers.
 *
 * IDs are plain strings (UUIDv7 — time-sortable) rather than driver-native types.
 * They cross into URLs, logs, provider payloads and MCP tool arguments, so a
 * database-specific ID type would leak the storage engine into every layer.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type UserId = Brand<string, 'UserId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type AgentVersionId = Brand<string, 'AgentVersionId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type RunId = Brand<string, 'RunId'>;
export type RunStepId = Brand<string, 'RunStepId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type CredentialId = Brand<string, 'CredentialId'>;
export type ProviderConfigId = Brand<string, 'ProviderConfigId'>;
export type ModelBindingId = Brand<string, 'ModelBindingId'>;
export type McpServerId = Brand<string, 'McpServerId'>;
export type McpBindingId = Brand<string, 'McpBindingId'>;
export type McpCapabilityId = Brand<string, 'McpCapabilityId'>;
export type PolicyId = Brand<string, 'PolicyId'>;
export type ChannelId = Brand<string, 'ChannelId'>;
export type ApiKeyId = Brand<string, 'ApiKeyId'>;
export type LeaseToken = Brand<string, 'LeaseToken'>;

/** Any branded id, for code that only needs to pass one through. */
export type AnyId = Brand<string, string>;

const HEX = '0123456789abcdef';

/**
 * UUIDv7: 48-bit big-endian Unix epoch milliseconds, 4-bit version, 74 bits of
 * randomness. Time-ordered, so it indexes well as a primary key and sorts
 * chronologically without a separate created-at index.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit timestamp, big endian.
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  // version 7 in the high nibble of byte 6; RFC 4122 variant in byte 8.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  let out = '';
  for (let i = 0; i < 16; i++) {
    const b = bytes[i] as number;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

/** Mints a prefixed, sortable id: `run_0199c2f1-...`. The prefix aids log triage. */
export function newId<T extends string>(prefix: T, now?: number): `${T}_${string}` {
  return `${prefix}_${uuidv7(now)}`;
}

export const IdPrefix = {
  user: 'usr',
  session: 'ses',
  identity: 'idt',
  authChallenge: 'chg',
  workspace: 'wks',
  agent: 'agt',
  agentVersion: 'agv',
  conversation: 'cnv',
  message: 'msg',
  run: 'run',
  runStep: 'stp',
  runEvent: 'evt',
  approval: 'apr',
  credential: 'crd',
  providerConfig: 'prv',
  modelBinding: 'mbd',
  mcpServer: 'mcs',
  mcpBinding: 'mcb',
  mcpCapability: 'cap',
  policy: 'pol',
  channel: 'chn',
  channelIdentity: 'cid',
  channelEvent: 'cev',
  apiKey: 'key',
  lease: 'lse',
  auditEntry: 'aud',
  usageDay: 'usg',
  subscription: 'sub',
} as const;

/** Casts a raw string to a branded id. Use only at trust boundaries (db reads, validated input). */
export const asId = <T extends AnyId>(raw: string): T => raw as T;
