/**
 * The owner's overview.
 *
 * One request that answers the questions an owner has when they open the
 * page: what is it costing, is anything stuck, who is in here. Counts are
 * read directly; the run figures come from the last seven days of runs and
 * the spend from the daily usage rollup, so a busy month is still one read
 * of a few hundred small rows.
 */
import { AuditRepository, ModelBindingRepository, ScopedDb, WorkspaceRepository } from '@salvations/db';
import type { AgentDoc, ChannelDoc } from '@salvations/db';
import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;
const SPEND_DAYS = 14;

export const GET = workspaceRoute('workspace:manage', async (ctx) => {
  const scoped = new ScopedDb(ctx.database, ctx.workspaceId);
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);

  const [workspace, agents, channels, providers, bindings, pending, runs, days, spendToday, audit] = await Promise.all([
    new WorkspaceRepository(ctx.database).findById(ctx.workspaceId),
    scoped.collection<AgentDoc>('agents').find({ isArchived: false } as never, { projection: { name: 1 } }),
    scoped.collection<ChannelDoc>('channels').countDocuments({} as never),
    new ModelBindingRepository(ctx.database, ctx.workspaceId).listProviders(),
    ctx.repos.models.list(),
    ctx.repos.runs.pendingApprovals(),
    ctx.repos.runs.summarySince(since),
    ctx.repos.usage.listDays(SPEND_DAYS * 8),
    ctx.repos.usage.spendOnDay(),
    new AuditRepository(ctx.database, ctx.workspaceId).list(20),
  ]);

  // Runs by outcome and by assistant, over the window.
  const byStatus: Record<string, number> = {};
  const byAgent = new Map<string, { runs: number; costUsd: number; failed: number }>();
  let windowCost = 0;
  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    windowCost += run.costUsd;
    const row = byAgent.get(run.agentId) ?? { runs: 0, costUsd: 0, failed: 0 };
    row.runs += 1;
    row.costUsd += run.costUsd;
    if (run.status === 'failed') row.failed += 1;
    byAgent.set(run.agentId, row);
  }

  // Spend per day for the chart: every day of the range, zero where nothing ran.
  const perDay = new Map<string, number>();
  const perBinding = new Map<string, { costUsd: number; runs: number }>();
  const floor = new Date(Date.now() - (SPEND_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  for (const row of days) {
    if (row.day >= floor) perDay.set(row.day, (perDay.get(row.day) ?? 0) + (row.costUsd ?? 0));
    const b = perBinding.get(row.modelBindingId) ?? { costUsd: 0, runs: 0 };
    b.costUsd += row.costUsd ?? 0;
    b.runs += row.runCount ?? 0;
    perBinding.set(row.modelBindingId, b);
  }
  const spendByDay: { day: string; costUsd: number }[] = [];
  for (let i = SPEND_DAYS - 1; i >= 0; i -= 1) {
    const day = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    spendByDay.push({ day, costUsd: perDay.get(day) ?? 0 });
  }

  const agentName = new Map(agents.map((a) => [a._id, a.name]));
  const bindingName = new Map(bindings.map((b) => [b._id, `${b.displayName} (${b.role})`]));
  const members = (workspace?.members ?? []).filter((m) => m.status === 'active');

  return ok({
    workspace: {
      name: workspace?.name ?? '',
      plan: workspace?.plan ?? 'free',
      settings: workspace?.settings,
      createdAt: workspace?.createdAt.toISOString(),
    },
    counts: {
      assistants: agents.length,
      members: members.length,
      owners: members.filter((m) => m.role === 'owner').length,
      invitations: (workspace?.invitations ?? []).filter((i) => i.expiresAt.getTime() > Date.now()).length,
      channels,
      providers: providers.length,
      pendingApprovals: pending.length,
    },
    spend: {
      todayUsd: spendToday,
      dailyCapUsd: workspace?.settings.dailyCostCapUsd ?? 0,
      windowUsd: windowCost,
      byDay: spendByDay,
      byModel: [...perBinding.entries()]
        .map(([id, row]) => ({ id, name: bindingName.get(id) ?? id, ...row }))
        .sort((a, b) => b.costUsd - a.costUsd),
    },
    runs: {
      windowDays: WINDOW_DAYS,
      total: runs.length,
      byStatus,
      byAgent: [...byAgent.entries()]
        .map(([id, row]) => ({ id, name: agentName.get(id) ?? 'Removed assistant', ...row }))
        .sort((a, b) => b.runs - a.runs),
    },
    audit: audit.map((entry) => ({
      id: entry._id,
      action: entry.action,
      actor: entry.actor,
      subject: entry.subject,
      at: entry.createdAt.toISOString(),
    })),
  });
});
