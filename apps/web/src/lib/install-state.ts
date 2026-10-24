/**
 * What rides through a platform's consent redirect when one of our own apps
 * is being installed.
 *
 * The platform hands back only `code` and `state`. The state is a token we
 * signed, naming the workspace, the assistant and the person who pressed
 * the button, so nothing is filed anywhere until the platform has actually
 * issued a token, and the callback can refuse to finish for anyone else.
 * The audience names the platform, so a Slack state cannot finish a Discord
 * install.
 */
import { JwtError, signHs256, verifyHs256 } from '@salvations/auth';
import { randomBytes } from 'node:crypto';
import { issuer } from './session';

/** How long the person has to finish on the platform's screen. */
export const INSTALL_STATE_TTL_SECONDS = 10 * 60;

export interface PendingInstall {
  readonly workspaceId: string;
  readonly agentId: string;
  /** Who pressed the button here. Only they may finish. */
  readonly userId: string;
}

export interface StateOptions { readonly issuer?: string; readonly now?: () => number }

export function signInstallState(secret: string, audience: string, pending: PendingInstall, options: StateOptions = {}): string {
  return signHs256(secret, {
    issuer: options.issuer ?? issuer(),
    audience,
    subject: pending.userId,
    expiresInSeconds: INSTALL_STATE_TTL_SECONDS,
    ...(options.now !== undefined ? { now: options.now } : {}),
    claims: { ws: pending.workspaceId, agent: pending.agentId, nonce: randomBytes(12).toString('base64url') },
  });
}

/** The pending install a state names, or undefined for one that is forged, expired or for another platform. */
export function readInstallState(state: string, secret: string, audience: string, options: StateOptions = {}): PendingInstall | undefined {
  try {
    const claims = verifyHs256(state, secret, {
      issuer: options.issuer ?? issuer(),
      audience,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    if (typeof claims['ws'] !== 'string' || typeof claims['agent'] !== 'string') return undefined;
    return { workspaceId: claims['ws'], agentId: claims['agent'], userId: claims.sub };
  } catch (caught) {
    if (caught instanceof JwtError) return undefined;
    throw caught;
  }
}
