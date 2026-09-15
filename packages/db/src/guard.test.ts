import { describe, expect, it } from 'vitest';
import {
  analyzeCommand, filterConstrainsWorkspace, pipelineConstrainsWorkspace,
  handleCommandStarted, TenancyViolationError, defaultGuardMode,
} from './guard.js';

const WS = 'wks_1';

describe('filterConstrainsWorkspace', () => {
  it('accepts a direct equality', () => {
    expect(filterConstrainsWorkspace({ workspaceId: WS })).toBe(true);
  });

  it('accepts an explicit $eq and a non-empty $in', () => {
    expect(filterConstrainsWorkspace({ workspaceId: { $eq: WS } })).toBe(true);
    expect(filterConstrainsWorkspace({ workspaceId: { $in: [WS, 'wks_2'] } })).toBe(true);
  });

  it('rejects operators that match every tenant', () => {
    // These look like constraints but select across the whole collection.
    expect(filterConstrainsWorkspace({ workspaceId: { $exists: true } })).toBe(false);
    expect(filterConstrainsWorkspace({ workspaceId: { $ne: null } })).toBe(false);
    expect(filterConstrainsWorkspace({ workspaceId: { $nin: ['wks_2'] } })).toBe(false);
    expect(filterConstrainsWorkspace({ workspaceId: { $in: [] } })).toBe(false);
  });

  it('rejects an empty or absent filter', () => {
    expect(filterConstrainsWorkspace({})).toBe(false);
    expect(filterConstrainsWorkspace(undefined)).toBe(false);
    expect(filterConstrainsWorkspace({ status: 'queued' })).toBe(false);
  });

  it('accepts $and when any branch constrains', () => {
    expect(filterConstrainsWorkspace({
      $and: [{ status: 'queued' }, { workspaceId: WS }],
    })).toBe(true);
  });

  it('requires EVERY $or branch to constrain — the subtle leak', () => {
    // One escaping branch exposes every tenant. This is the case a reviewer misses.
    expect(filterConstrainsWorkspace({
      $or: [{ workspaceId: WS }, { isPublic: true }],
    })).toBe(false);

    expect(filterConstrainsWorkspace({
      $or: [{ workspaceId: WS, kind: 'a' }, { workspaceId: WS, kind: 'b' }],
    })).toBe(true);
  });

  it('handles nesting', () => {
    expect(filterConstrainsWorkspace({
      $and: [{ $or: [{ workspaceId: WS, a: 1 }, { workspaceId: WS, a: 2 }] }],
    })).toBe(true);
  });
});

describe('pipelineConstrainsWorkspace', () => {
  it('accepts a leading $match on workspaceId', () => {
    expect(pipelineConstrainsWorkspace([{ $match: { workspaceId: WS } }, { $limit: 10 }])).toBe(true);
  });

  it('rejects a $match that arrives after a data-reaching stage', () => {
    expect(pipelineConstrainsWorkspace([
      { $lookup: { from: 'messages', as: 'm' } },
      { $match: { workspaceId: WS } },
    ])).toBe(false);
  });

  it('rejects an empty pipeline', () => {
    expect(pipelineConstrainsWorkspace([])).toBe(false);
  });

  it('requires a vector search to carry the tenant filter INSIDE the stage', () => {
    // A $vectorSearch is not constrained by anything downstream: a later $match
    // filters results the search already chose from every tenant's vectors.
    expect(pipelineConstrainsWorkspace([
      { $vectorSearch: { index: 'chunks', path: 'embeddings.m', queryVector: [], limit: 10 } },
      { $match: { workspaceId: WS } },
    ])).toBe(false);

    expect(pipelineConstrainsWorkspace([
      { $vectorSearch: {
          index: 'chunks', path: 'embeddings.m', queryVector: [], limit: 10,
          filter: { workspaceId: WS },
      } },
    ])).toBe(true);
  });
});

describe('analyzeCommand', () => {
  it('ignores collections owned by the auth library', () => {
    expect(analyzeCommand('find', { find: 'session', filter: {} })).toBeUndefined();
    expect(analyzeCommand('find', { find: 'user', filter: { email: 'a@b.c' } })).toBeUndefined();
  });

  it('flags an unscoped find on a tenant collection', () => {
    const v = analyzeCommand('find', { find: 'conversations', filter: {} });
    expect(v?.reason).toBe('missing_workspace_filter');
  });

  it('passes a scoped find', () => {
    expect(analyzeCommand('find', {
      find: 'conversations', filter: { workspaceId: WS, agentId: 'agt_1' },
    })).toBeUndefined();
  });

  it('flags update and delete without a tenant constraint', () => {
    expect(analyzeCommand('update', {
      update: 'agents', updates: [{ q: { slug: 'x' }, u: { $set: { name: 'y' } } }],
    })?.reason).toBe('missing_workspace_filter');

    expect(analyzeCommand('delete', {
      delete: 'agents', deletes: [{ q: {}, limit: 0 }],
    })?.reason).toBe('missing_workspace_filter');
  });

  it('flags a multi-statement update where only one statement is scoped', () => {
    expect(analyzeCommand('update', {
      update: 'agents',
      updates: [
        { q: { workspaceId: WS }, u: { $set: { a: 1 } } },
        { q: { slug: 'leaky' }, u: { $set: { a: 2 } } },
      ],
    })?.reason).toBe('missing_workspace_filter');
  });

  it('flags an insert whose document carries no workspaceId', () => {
    expect(analyzeCommand('insert', {
      insert: 'messages', documents: [{ _id: 'm1', role: 'user' }],
    })?.reason).toBe('missing_workspace_on_insert');
  });

  it('passes an insert that is stamped', () => {
    expect(analyzeCommand('insert', {
      insert: 'messages', documents: [{ _id: 'm1', workspaceId: WS }],
    })).toBeUndefined();
  });

  it('flags a collection nobody classified', () => {
    // An unclassified collection is an unguarded collection.
    const v = analyzeCommand('find', { find: 'someNewThing', filter: {} });
    expect(v?.reason).toBe('unknown_collection');
  });

  it('allows a deliberate cross-workspace operation that declares itself', () => {
    // The queue claim must span workspaces to schedule fairly. It says so.
    expect(analyzeCommand('findAndModify', {
      findAndModify: 'runs',
      query: { status: 'queued' },
      comment: { salvations: 'platform:queue-claim' },
    })).toBeUndefined();
  });

  it('does not let an arbitrary comment become an escape hatch', () => {
    expect(analyzeCommand('find', {
      find: 'runs', filter: {}, comment: 'just a note',
    })?.reason).toBe('missing_workspace_filter');
  });

  it('ignores cursor continuation, whose originating command was already checked', () => {
    expect(analyzeCommand('getMore', { getMore: 1, collection: 'messages' })).toBeUndefined();
  });

  it('ignores index and admin commands', () => {
    expect(analyzeCommand('createIndexes', { createIndexes: 'runs', indexes: [] })).toBeUndefined();
    expect(analyzeCommand('ping', { ping: 1 })).toBeUndefined();
  });
});

describe('guard modes', () => {
  it('throws outside production so a violation fails the build', () => {
    expect(defaultGuardMode('test')).toBe('throw');
    expect(defaultGuardMode('development')).toBe('throw');
    expect(() =>
      handleCommandStarted(
        { commandName: 'find', command: { find: 'runs', filter: {} } },
        { mode: 'throw' },
      ),
    ).toThrow(TenancyViolationError);
  });

  it('reports in production rather than failing a live request', () => {
    expect(defaultGuardMode('production')).toBe('report');
    const seen: string[] = [];
    handleCommandStarted(
      { commandName: 'find', command: { find: 'runs', filter: {} } },
      { mode: 'report', onViolation: (v) => seen.push(v.reason) },
    );
    expect(seen).toEqual(['missing_workspace_filter']);
  });

  it('stays silent on a well-scoped command', () => {
    const seen: string[] = [];
    handleCommandStarted(
      { commandName: 'find', command: { find: 'runs', filter: { workspaceId: WS } } },
      { mode: 'throw', onViolation: (v) => seen.push(v.reason) },
    );
    expect(seen).toEqual([]);
  });
});
