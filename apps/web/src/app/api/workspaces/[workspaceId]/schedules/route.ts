/**
 * Recurring instructions.
 *
 * The expression and the zone are checked HERE, against the same parser the
 * tick uses. Storing an expression nobody has parsed produces a schedule that
 * fails every minute for ever and tells the person nothing at the one moment
 * they were looking.
 */
import { createScheduleSchema } from '@salvations/contracts';
import { isValidCron, isValidTimeZone, parseCron, dueBetween } from '@salvations/schedule';
import { AgentRepository, ScheduleRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

/** How far ahead to look when telling somebody when a schedule will next run. */
const PREVIEW_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

export const GET = workspaceRoute('agents:read', async (ctx) => {
  const rows = await new ScheduleRepository(ctx.database, ctx.workspaceId).list();

  return ok({
    items: rows.map((row) => ({
      id: row._id,
      name: row.name,
      expression: row.expression,
      timeZone: row.timeZone,
      agentId: row.agentId,
      prompt: row.prompt,
      enabled: row.enabled,
      lastFiredFor: row.lastFiredFor?.toISOString(),
      lastRunId: row.lastRunId ?? undefined,
      consecutiveFailures: row.consecutiveFailures,
      lastError: row.lastError ?? undefined,
      // Computed, not stored: a stored next-run drifts the moment the
      // expression or the zone changes, and then the page lies.
      nextRunAt: nextRun(row.expression, row.timeZone),
    })),
  });
});

export const POST = workspaceRoute('agents:write', async (ctx) => {
  const input = await jsonBody(ctx.request, createScheduleSchema);

  if (!isValidCron(input.expression)) {
    return errorResponse(
      422, 'validation_failed',
      `"${input.expression}" is not a schedule. Five fields: minute hour day month weekday.`,
    );
  }
  if (!isValidTimeZone(input.timeZone)) {
    return errorResponse(
      422, 'validation_failed',
      `"${input.timeZone}" is not a time zone this server knows. Use an IANA name like Europe/London.`,
    );
  }

  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(input.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'That agent does not exist.');

  const binding = await ctx.repos.models.findById(input.modelBindingId);
  if (binding === null) return errorResponse(404, 'not_found', 'That model binding does not exist.');

  const created = await new ScheduleRepository(ctx.database, ctx.workspaceId).create({
    name: input.name,
    expression: input.expression,
    timeZone: input.timeZone,
    agentId: input.agentId,
    modelBindingId: input.modelBindingId,
    prompt: input.prompt,
    createdBy: actorIdOf(ctx.principal),
  });

  return ok({
    id: created._id,
    name: created.name,
    nextRunAt: nextRun(created.expression, created.timeZone),
  }, 201);
});

/**
 * When this will next fire.
 *
 * Found by walking forward from now, the same way the tick walks. A schedule
 * with no occurrence in the next year — 29 February on a weekday that never
 * coincides, say — honestly reports none rather than guessing.
 */
function nextRun(expression: string, timeZone: string): string | undefined {
  try {
    const fields = parseCron(expression);
    const now = new Date();
    const [first] = dueBetween(fields, timeZone, now, new Date(now.getTime() + PREVIEW_WINDOW_MS), 1);
    return first?.toISOString();
  } catch {
    return undefined;
  }
}
