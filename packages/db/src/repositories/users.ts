/**
 * People, sessions and identity links.
 *
 * Global rather than workspace-scoped, so these go through `PlatformDb` with an
 * explicit reason rather than `ScopedDb`: one human belongs to many workspaces,
 * and a per-workspace user row would mean the same person with several
 * passwords.
 *
 * Nothing here ever stores a bearer value. Passwords are hashed with scrypt,
 * refresh tokens with SHA-256, and a dump of these collections yields no
 * credential anyone can use.
 */
import type { Db } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import type { AuthSessionDoc, IdentityDoc, UserDoc } from '../documents';
import { PlatformDb } from '../scoped';

/**
 * Email is stored twice on purpose.
 *
 * `email` is the normalised key the unique index and every lookup use;
 * `emailDisplay` is what the person typed. Comparing on the display form is
 * how `Sam@Example.com` and `sam@example.com` become two accounts.
 */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

export interface CreateUserInput {
  readonly email: string;
  readonly name?: string;
  readonly passwordHash?: string;
  readonly emailVerified?: boolean;
  readonly imageUrl?: string;
}

export class UserRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #users() {
    return new PlatformDb(this.#db, 'user-workspaces').collection<UserDoc>('users');
  }

  #sessions() {
    return new PlatformDb(this.#db, 'user-workspaces').collection<AuthSessionDoc>('authSessions');
  }

  #identities() {
    return new PlatformDb(this.#db, 'user-workspaces').collection<IdentityDoc>('identities');
  }

  findById(userId: string): Promise<UserDoc | null> {
    return this.#users().findOne({ _id: userId });
  }

  findByEmail(email: string): Promise<UserDoc | null> {
    return this.#users().findOne({ email: normaliseEmail(email) });
  }

  /**
   * Creates a user.
   *
   * Relies on the unique index for uniqueness rather than a read-then-write: two
   * concurrent sign-ups for the same address would both see "not taken" and one
   * would silently overwrite the other.
   */
  async create(input: CreateUserInput): Promise<UserDoc> {
    const now = new Date();
    const doc: UserDoc = {
      _id: newId(IdPrefix.user),
      email: normaliseEmail(input.email),
      emailDisplay: input.email.trim(),
      emailVerifiedAt: input.emailVerified === true ? now : null,
      name: input.name ?? null,
      imageUrl: input.imageUrl ?? null,
      passwordHash: input.passwordHash ?? null,
      // Starts at 1 so "never revoked" is still a real epoch, not a falsy zero.
      sessionEpoch: 1,
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
      lastSignedInAt: null,
    };

    await this.#users().insertOne(doc);
    return doc;
  }

  /** A verified assertion of the address arrived — from Google, or a link. */
  async markEmailVerified(userId: string): Promise<void> {
    await this.#users().updateOne(
      { _id: userId, emailVerifiedAt: null },
      { $set: { emailVerifiedAt: new Date(), updatedAt: new Date() } },
    );
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    // Changing a password revokes every session, including the one doing the
    // changing. Anything else means a thief who learned the old password keeps
    // their session after the owner reacts.
    await this.#users().updateOne(
      { _id: userId },
      { $set: { passwordHash, updatedAt: new Date() }, $inc: { sessionEpoch: 1 } },
    );
  }

  /** Revokes every session for a user in one write. */
  async revokeAllSessions(userId: string, reason: string): Promise<void> {
    await this.#users().updateOne(
      { _id: userId },
      { $inc: { sessionEpoch: 1 }, $set: { updatedAt: new Date() } },
    );
    await this.#sessions().updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
  }

  /**
   * The walkthrough was finished or skipped. Either counts: a tour that comes
   * back every visit until it is watched to the end is a nag, not a guide.
   */
  async markWalkthroughSeen(userId: string): Promise<void> {
    await this.#users().updateOne(
      { _id: userId },
      { $set: { walkthroughSeenAt: new Date(), updatedAt: new Date() } },
    );
  }

  async recordSignIn(userId: string): Promise<void> {
    await this.#users().updateOne({ _id: userId }, { $set: { lastSignedInAt: new Date() } });
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  async createSession(input: {
    userId: string;
    refreshTokenHash: string;
    sessionEpoch: number;
    expiresAt: Date;
    idleExpiresAt: Date;
    userAgent?: string;
    ipHash?: string;
  }): Promise<AuthSessionDoc> {
    const now = new Date();
    const doc: AuthSessionDoc = {
      _id: newId(IdPrefix.session),
      userId: input.userId,
      refreshTokenHash: input.refreshTokenHash,
      sessionEpoch: input.sessionEpoch,
      rotatedAt: now,
      createdAt: now,
      expiresAt: input.expiresAt,
      idleExpiresAt: input.idleExpiresAt,
      userAgent: input.userAgent ?? null,
      ipHash: input.ipHash ?? null,
      revokedAt: null,
      revokedReason: null,
    };
    await this.#sessions().insertOne(doc);
    return doc;
  }

  findSession(sessionId: string): Promise<AuthSessionDoc | null> {
    return this.#sessions().findOne({ _id: sessionId });
  }

  /**
   * Finds a session by its refresh token hash.
   *
   * By HASH, so the lookup itself never handles the token, and the index is on
   * a value that is useless if the database leaks.
   */
  findSessionByRefreshHash(hash: string): Promise<AuthSessionDoc | null> {
    return this.#sessions().findOne({ refreshTokenHash: hash });
  }

  /**
   * Rotates a refresh token, atomically.
   *
   * Guarded on the OLD hash so two concurrent refreshes cannot both succeed:
   * the loser matches nothing and is told to sign in again, rather than both
   * walking away believing they hold the live token.
   */
  async rotateSession(
    sessionId: string,
    oldHash: string,
    next: { refreshTokenHash: string; idleExpiresAt: Date },
  ): Promise<boolean> {
    const result = await this.#sessions().updateOne(
      { _id: sessionId, refreshTokenHash: oldHash, revokedAt: null },
      {
        $set: {
          refreshTokenHash: next.refreshTokenHash,
          idleExpiresAt: next.idleExpiresAt,
          rotatedAt: new Date(),
        },
      },
    );
    return result.matchedCount === 1;
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.#sessions().updateOne(
      { _id: sessionId },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
  }

  listSessions(userId: string): Promise<AuthSessionDoc[]> {
    return this.#sessions()
      .find({ userId, revokedAt: null }, { sort: { createdAt: -1 }, limit: 50 })
      .toArray();
  }

  // ─── Identity links ───────────────────────────────────────────────────────

  findIdentity(provider: 'google', subject: string): Promise<IdentityDoc | null> {
    return this.#identities().findOne({ provider, subject });
  }

  async linkIdentity(input: {
    userId: string;
    provider: 'google';
    subject: string;
    email: string;
    emailVerified: boolean;
    hostedDomain?: string;
  }): Promise<IdentityDoc> {
    const now = new Date();
    const doc: IdentityDoc = {
      _id: newId(IdPrefix.identity),
      userId: input.userId,
      provider: input.provider,
      subject: input.subject,
      email: normaliseEmail(input.email),
      emailVerified: input.emailVerified,
      hostedDomain: input.hostedDomain ?? null,
      createdAt: now,
      lastUsedAt: now,
    };
    await this.#identities().insertOne(doc);
    return doc;
  }

  async touchIdentity(identityId: string, email: string): Promise<void> {
    // The email is refreshed because a person can change it at the provider;
    // the SUBJECT is what the link is keyed on and never changes.
    await this.#identities().updateOne(
      { _id: identityId },
      { $set: { lastUsedAt: new Date(), email: normaliseEmail(email) } },
    );
  }

  listIdentities(userId: string): Promise<IdentityDoc[]> {
    return this.#identities().find({ userId }).toArray();
  }
}
