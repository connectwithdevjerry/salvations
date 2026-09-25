/**
 * What this workspace has been doing.
 *
 * Runs, plus the two numbers that actually predict a bill: what has been spent
 * today, and how much of the input was served from cache. A loop re-sends the
 * whole conversation on every step, so at any real length most input tokens
 * SHOULD be cache reads — when that falls, the bill roughly triples with
 * nothing else on the page looking wrong.
 */
import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

const LIMIT = 50;

export const GET = workspaceRoute('runs:read', async (ctx) => {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get('status') ?? undefined;

  const runs = await ctx.repos.runs.listRecent(
    LIMIT,
    // Only a real status filters; the UI's "all" tab must not become a search
    // for runs whose status is the literal string "all".
    status === null || status === '' || status === 'all' ? undefined : status,
  );

  const [spendToday, cache] = await Promise.all([
    ctx.repos.usage.spendOnDay(),
    ctx.repos.usage.cacheHitRate(),
  ]);

  return ok({
    items: runs.map((run) => ({
      id: run._id,
      conversationId: run.conversationId,
      agentId: run.agentId,
      status: run.status,
      trigger: run.trigger.type,
      triggerRef: run.trigger.ref ?? undefined,
      steps: run.consumed?.steps ?? 0,
      toolCalls: run.consumed?.toolCalls ?? 0,
      tokens: run.consumed?.tokens ?? 0,
      costUsd: run.consumed?.costUsd ?? 0,
      queuedAt: run.queuedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
      error: run.error?.message,
    })),
    totals: {
      spendTodayUsd: spendToday,
      // Absent rather than zero when nothing has run. A 0% cache rate and "no
      // data yet" mean opposite things, and collapsing them would show a brand
      // new workspace an alarming red number for a day that has not happened.
      ...(cache.rate !== undefined ? { cacheHitRate: cache.rate } : {}),
      cacheReadTokens: cache.cacheReadTokens,
      freshInputTokens: cache.freshInputTokens,
    },
  });
});
