/**
 * Tying a chat account to a HIVE account.
 *
 * A Telegram id proves somebody can reach the bot and nothing more, so a
 * run it starts carries `trust: 'unlinked'` and the permissions of a
 * stranger. Linking is how that changes: the person asks for a code while
 * signed in here, sends it in the chat, and from then on the chat identity
 * is theirs. Their runs carry their account, and policy can treat them as
 * the member they are.
 *
 * The code is issued to the account, not to a workspace; the chat it is
 * sent to belongs to a workspace, and the person has to be a member of that
 * one. A code from an account with no standing in the workspace links
 * nothing.
 */
import { createHash } from 'node:crypto';
import type { InboundMessage } from '@salvations/channels';
import {
  UserRepository, WorkspaceRepository, type ChannelDoc, type ChannelRepository, type Database,
} from '@salvations/db';
import { connectCode } from './connect-code';

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_WRONG_GUESSES = 5;

/** The code's hash, which is all that is stored. */
export const hashLinkCode = (code: string): string =>
  createHash('sha256').update(`chat_link:${code.trim().toUpperCase()}`).digest('hex');

/** A code for this person, replacing any they already had. */
export async function issueLinkCode(database: Database, userId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = connectCode();
  const challenge = await new UserRepository(database).issueChallenge({
    userId, kind: 'chat_link', tokenHash: hashLinkCode(code), ttlMs: LINK_CODE_TTL_MS,
  });
  return { code, expiresAt: challenge.expiresAt };
}

/**
 * The code a message is offering, if it is offering one.
 *
 * Only a message that is nothing but the code, with or without the word
 * "link" in front, counts. An eight-letter word inside a sentence is a word.
 */
export function offeredLinkCode(text: string): string | undefined {
  const match = /^(?:link\s+)?([A-Za-z0-9]{8})$/i.exec(text.trim());
  if (match === null) return undefined;
  const code = (match[1] as string).toUpperCase();
  return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(code) ? code : undefined;
}

export interface LinkAttempt {
  /** What to say back. */
  readonly text: string;
  readonly linked: boolean;
}

/**
 * Acts on a code sent in a chat. Undefined when the message was not one.
 */
export async function linkFromChat(input: {
  readonly database: Database;
  readonly row: ChannelDoc;
  readonly message: InboundMessage;
  readonly channels: ChannelRepository;
}): Promise<LinkAttempt | undefined> {
  const code = offeredLinkCode(input.message.text);
  if (code === undefined) return undefined;

  const users = new UserRepository(input.database);
  const challenge = await users.findOpenChallengeByToken('chat_link', hashLinkCode(code));
  if (challenge === null) {
    return { text: 'That code is not right, or it has expired. Ask for a new one on your Settings page.', linked: false };
  }
  if ((challenge.attempts ?? 0) >= MAX_WRONG_GUESSES) {
    return { text: 'That code has been tried too often. Ask for a new one on your Settings page.', linked: false };
  }

  const membership = await new WorkspaceRepository(input.database).membershipOf(input.row.workspaceId, challenge.userId);
  if (membership === null || membership.status !== 'active') {
    await users.recordChallengeAttempt(challenge._id);
    return { text: 'That code belongs to an account that is not in this workspace.', linked: false };
  }

  const identity = await input.channels.findIdentity(input.row._id, input.message.senderRef);
  if (identity === null) {
    // No row yet: the first thing this person sent was the code. Say so and
    // let the next message create the row; the code stays valid.
    return { text: 'Say hello first, then send the code again.', linked: false };
  }

  if (!await users.consumeChallenge(challenge._id)) {
    return { text: 'That code was just used. Ask for a new one if you need it.', linked: false };
  }
  await input.channels.setIdentityUser(identity._id, challenge.userId);
  const account = await users.findById(challenge.userId);
  const who = account?.name ?? account?.emailDisplay ?? account?.email ?? 'your account';
  return { text: `Linked. This chat is now ${who}. I will treat what you ask as coming from you.`, linked: true };
}
