import { randomInt } from 'node:crypto';

/**
 * The alphabet for a code somebody reads off one screen and types into another.
 *
 * No O, 0, I, 1 or L. Those are the pairs people transcribe wrongly, and a code
 * that fails because of a font is indistinguishable from one that failed
 * because it expired.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const CONNECT_CODE_LENGTH = 8;

/**
 * A one-time code proving somebody controls a chat.
 *
 * `randomInt` rather than `Math.random`: this code is the entire ownership
 * proof for a connection, and a predictable one lets somebody who has seen a
 * bot token claim the chat before its owner does.
 *
 * Eight characters of a 31-symbol alphabet is about 40 bits. The code also
 * expires in half an hour and is cleared the moment it is used, so guessing
 * means roughly 10^12 attempts against a chat that answers one message at a
 * time.
 */
export function connectCode(): string {
  let code = '';
  for (let index = 0; index < CONNECT_CODE_LENGTH; index += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}
