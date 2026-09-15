import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message, MessageId, ModelCapabilities } from '@salvations/core';
import {
  DEFAULT_COMPACTION_THRESHOLD, compact, fallbackSummary, planCompaction,
} from './compaction';

const capabilities = (maxInputTokens: number): ModelCapabilities =>
  ({ maxInputTokens }) as ModelCapabilities;

let seq = 0;
const message = (
  role: Message['role'], tokenEstimate: number, content?: readonly ContentBlock[],
): Message => ({
  id: `msg_${seq}` as MessageId,
  conversationId: 'cnv_1' as Message['conversationId'],
  seq: seq++,
  role,
  content: content ?? [{ type: 'text', text: 'x'.repeat(tokenEstimate * 4) }],
  tokenEstimate,
  createdAt: new Date(0),
});

const conversation = (count: number, tokensEach = 100): Message[] => {
  seq = 0;
  return Array.from({ length: count }, (_, i) =>
    message(i % 2 === 0 ? 'user' : 'assistant', tokensEach));
};

const signal = new AbortController().signal;

describe('when to compact', () => {
  it('leaves a conversation that fits comfortably alone', () => {
    const plan = planCompaction(conversation(4), capabilities(100_000));
    expect(plan.needed).toBe(false);
    expect(plan.toKeep).toHaveLength(4);
  });

  it('compacts once the history passes the threshold', () => {
    const messages = conversation(40, 100);
    const plan = planCompaction(messages, capabilities(1_000));

    expect(plan.needed).toBe(true);
    expect(plan.estimatedTokensBefore).toBe(4_000);
    expect(plan.estimatedTokensAfter).toBeLessThan(plan.estimatedTokensBefore);
  });

  it('uses the threshold as a fraction of the model’s own window', () => {
    // A 200k model and a 8k model should not share a fixed number.
    const messages = conversation(20, 100);
    expect(planCompaction(messages, capabilities(10_000)).needed).toBe(false);
    expect(planCompaction(messages, capabilities(1_000)).needed).toBe(true);
    expect(DEFAULT_COMPACTION_THRESHOLD).toBeLessThan(1);
  });

  it('ignores messages an edit already superseded', () => {
    const messages = conversation(20, 100).map((m, i) =>
      i < 18 ? { ...m, supersededBy: 'msg_x' as MessageId } : m);
    expect(planCompaction(messages, capabilities(1_000)).needed).toBe(false);
  });

  it('says so rather than looping when compaction cannot help', () => {
    // The recent window alone exceeds the target; summarising older turns
    // would not bring it under, and retrying would spin.
    const messages = conversation(6, 5_000);
    const plan = planCompaction(messages, capabilities(1_000));

    expect(plan.needed).toBe(false);
    expect(plan.reason).toMatch(/recent turns alone exceed/);
  });
});

describe('what is kept', () => {
  it('always keeps the most recent turns verbatim', () => {
    const messages = conversation(40, 100);
    const plan = planCompaction(messages, capabilities(1_000), { keepRecent: 6 });
    expect(plan.toKeep.length).toBeGreaterThanOrEqual(6);
    expect(plan.toKeep.at(-1)?.id).toBe(messages.at(-1)?.id);
  });

  it('summarises the oldest, in order', () => {
    const messages = conversation(40, 100);
    const plan = planCompaction(messages, capabilities(1_000));
    expect(plan.toSummarise[0]?.id).toBe(messages[0]?.id);
    expect(plan.toSummarise.map((m) => m.seq))
      .toEqual([...plan.toSummarise.map((m) => m.seq)].sort((a, b) => a - b));
  });

  it('accounts for every message: nothing is silently dropped', () => {
    const messages = conversation(40, 100);
    const plan = planCompaction(messages, capabilities(1_000));
    expect(plan.toSummarise.length + plan.toKeep.length).toBe(messages.length);
  });
});

describe('tool pairs are never split', () => {
  const withToolPair = (): Message[] => {
    seq = 0;
    const before = Array.from({ length: 30 }, () => message('user', 100));
    const asking = message('assistant', 100, [
      { type: 'tool_use', id: 't1', name: 'a__x', input: {} },
    ]);
    const answering = message('tool', 100, [
      { type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'r' }], isError: false },
    ]);
    const after = Array.from({ length: 4 }, () => message('assistant', 100));
    return [...before, asking, answering, ...after];
  };

  it('does not cut between a tool call and its result', () => {
    // Every provider rejects a history with one without the other, so a bad
    // boundary turns a long conversation into a hard failure.
    const messages = withToolPair();
    const plan = planCompaction(messages, capabilities(1_000), { keepRecent: 5 });

    const keptIds = new Set(plan.toKeep.map((m) => m.id));
    const asking = messages[30] as Message;
    const answering = messages[31] as Message;
    expect(keptIds.has(asking.id)).toBe(keptIds.has(answering.id));
  });

  it('moves the boundary back rather than forward, so the pair stays whole', () => {
    const messages = withToolPair();
    const plan = planCompaction(messages, capabilities(1_000), { keepRecent: 5 });
    // Whatever the target wanted, the cut landed on a legal boundary.
    const first = plan.toKeep[0];
    expect(first?.content.some((b) => b.type === 'tool_result')).toBe(false);
  });
});

describe('the summary message', () => {
  it('labels itself as a summary', async () => {
    // A model reading its own context must know a passage is a compressed
    // account, or it quotes it back as if someone said it.
    const plan = planCompaction(conversation(40, 100), capabilities(1_000));
    const result = await compact(plan, async () => 'They discussed scheduling.', signal);

    const text = (result.summary[0] as { text: string }).text;
    expect(text).toMatch(/compressed account, not a verbatim transcript/);
    expect(text).toContain('They discussed scheduling.');
  });

  it('names what it replaced, so nothing disappears silently', async () => {
    const plan = planCompaction(conversation(40, 100), capabilities(1_000));
    const result = await compact(plan, async () => 's', signal);
    expect(result.supersededIds).toEqual(plan.toSummarise.map((m) => m.id));
  });

  it('reports the saving, so the decision is auditable', async () => {
    const plan = planCompaction(conversation(40, 100), capabilities(1_000));
    const result = await compact(plan, async () => 's', signal);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
  });

  it('passes only the messages being replaced to the summariser', async () => {
    let received = 0;
    const plan = planCompaction(conversation(40, 100), capabilities(1_000));
    await compact(plan, async (messages) => { received = messages.length; return 's'; }, signal);
    expect(received).toBe(plan.toSummarise.length);
  });

  it('refuses to compact when the plan says there is nothing to do', async () => {
    const plan = planCompaction(conversation(2), capabilities(100_000));
    await expect(compact(plan, async () => 's', signal)).rejects.toThrow(/Nothing to compact/);
  });
});

describe('the fallback summary', () => {
  it('keeps something readable when the summarising model is down', () => {
    // Losing detail is bad; losing the run because the summariser was down is
    // worse.
    seq = 0;
    const text = fallbackSummary([
      message('user', 1, [{ type: 'text', text: 'Book a room' }]),
      message('assistant', 1, [{ type: 'text', text: 'Which day?' }]),
    ]);
    expect(text).toBe('user: Book a room\nassistant: Which day?');
  });

  it('truncates a very long turn rather than reproducing it whole', () => {
    seq = 0;
    const text = fallbackSummary([message('user', 1, [{ type: 'text', text: 'y'.repeat(1_000) }])]);
    expect(text.length).toBeLessThan(250);
    expect(text).toMatch(/…$/);
  });
});
