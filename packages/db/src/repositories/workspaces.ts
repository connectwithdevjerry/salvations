/**
 * Workspace and membership access.
 *
 * Members are embedded in the workspace document, so the hot authorization
 * question — "is this user a member here, and with what role?" — is a single
 * indexed read rather than a join.
 */
import type { Db } from 'mongodb';
import type { Role } from '@salvations/core';
import type { WorkspaceDoc, WorkspaceMemberSub } from '../documents';
import { PlatformDb, ScopedDb, type ScopedCollection } from '../scoped';

/** Documented cap; beyond this a workspace migrates to its own collection. */
export const MAX_EMBEDDED_MEMBERS = 500;

export class MemberLimitError extends Error {
  constructor(workspaceId: string) {
    super(
      `Workspace ${workspaceId} has reached the ${MAX_EMBEDDED_MEMBERS}-member embedding cap. ` +
        'Migrate it to a separate members collection — the repository interface does not change.',
    );
    this.name = 'MemberLimitError';
  }
}

export interface Membership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: Role;
  readonly status: 'active' | 'suspended';
}

export class WorkspaceRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #scoped(workspaceId: string): ScopedCollection<WorkspaceDoc> {
    return new ScopedDb(this.#db, workspaceId).collection<WorkspaceDoc>('workspaces');
  }

  async findById(workspaceId: string): Promise<WorkspaceDoc | null> {
    return this.#scoped(workspaceId).findOne({ _id: workspaceId } as never);
  }

  /**
   * The hot authorization path: one indexed read, properly workspace-scoped.
   *
   * A suspended member is NOT a member for authorization purposes — returning
   * the row and leaving the caller to check status invites a forgotten check.
   */
  async membershipOf(workspaceId: string, userId: string): Promise<Membership | null> {
    const doc = await this.#scoped(workspaceId).findOne(
      { _id: workspaceId, 'members.userId': userId } as never,
      { projection: { 'members.$': 1, slug: 1 } },
    );
    const member = doc?.members?.[0];
    if (member === undefined || member.status !== 'active') return null;
    return { workspaceId, userId, role: member.role as Role, status: member.status };
  }

  /**
   * Workspaces a user belongs to.
   *
   * Scoped by user rather than by workspace, so it cannot carry a workspaceId
   * filter and must declare itself a platform operation.
   */
  async listForUser(userId: string): Promise<{ id: string; slug: string; name: string; role: Role }[]> {
    const platform = new PlatformDb(this.#db, 'user-workspaces');
    const docs = await platform
      .collection<WorkspaceDoc>('workspaces')
      .find(
        { 'members.userId': userId, 'members.status': 'active', deletedAt: null },
        { projection: { slug: 1, name: 1, 'members.$': 1 }, comment: platform.comment },
      )
      .toArray();

    return docs.map((doc) => ({
      id: doc._id,
      slug: doc.slug,
      name: doc.name,
      role: (doc.members?.[0]?.role ?? 'viewer') as Role,
    }));
  }

  async addMember(
    workspaceId: string,
    member: WorkspaceMemberSub,
  ): Promise<void> {
    const existing = await this.findById(workspaceId);
    if (existing === null) throw new Error(`Workspace ${workspaceId} not found.`);
    if ((existing.members?.length ?? 0) >= MAX_EMBEDDED_MEMBERS) {
      throw new MemberLimitError(workspaceId);
    }
    // Targeted $push rather than rewriting the array: concurrent invitations
    // must not clobber each other.
    await this.#scoped(workspaceId).updateOne(
      { _id: workspaceId, 'members.userId': { $ne: member.userId } } as never,
      { $push: { members: member }, $set: { updatedAt: new Date() } } as never,
    );
  }

  /** Changes a member's role in place, never by rewriting the whole array. */
  async setMemberRole(workspaceId: string, userId: string, role: Role): Promise<boolean> {
    const result = await this.#scoped(workspaceId).updateOne(
      { _id: workspaceId } as never,
      { $set: { 'members.$[m].role': role, updatedAt: new Date() } } as never,
      { arrayFilters: [{ 'm.userId': userId }] },
    );
    return result.matchedCount === 1;
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await this.#scoped(workspaceId).updateOne(
      { _id: workspaceId } as never,
      { $pull: { members: { userId } }, $set: { updatedAt: new Date() } } as never,
    );
  }

  /**
   * An owner may not be removed or demoted while they are the last one.
   *
   * Without this a workspace can be orphaned — no one left who can manage
   * billing, membership, or deletion — and recovering it needs support access.
   */
  async isLastOwner(workspaceId: string, userId: string): Promise<boolean> {
    const doc = await this.findById(workspaceId);
    if (doc === null) return false;
    const owners = (doc.members ?? []).filter(
      (m) => m.role === 'owner' && m.status === 'active',
    );
    return owners.length === 1 && owners[0]?.userId === userId;
  }
}
