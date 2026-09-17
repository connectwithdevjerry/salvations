/**
 * Firing what is due.
 *
 * Runs on the sweeper's invocation, because the sweeper already exists, is
 * already signed, and already runs often. A second cron endpoint would be a
 * second thing to schedule, secure and monitor for no gain.
 *
 * The claim comes BEFORE the run is created, and that order is deliberate. A
 * run created first and claimed second would be created twice whenever two
 * ticks overlap; claimed first, the loser of the race creates nothing. The cost
 * is that a crash between the claim and the run loses that one occurrence —
 * which is the right trade for a recurring job, where the next one is minutes
 * away and a duplicate could spend real money.
 */
import {
  AgentRepository, ConversationRepository, ScheduleRepository, enabledSchedules,
  type ScheduleDoc,
} from '@salvations/db';
import { dueBetween, parseCron } from '@salvations/schedule';
import { DEFAULT_BUDGET, asId, type RunId, type WorkspaceId } from '@salvations/core';
import { db } from './db';
import { repositories } from './container';
import { VercelBackgroundTrigger } from './trigger';

/**
 * How many missed occurrences one schedule may catch up on in a single tick.
 *
 * A scheduler that has been down for a day must come back to a catch-up, not a
 * stampede: an every-minute schedule would otherwise fire fourteen hundred runs
 * at once against somebody's budget.
 */
export const CATCH_UP_LIMIT = 5;

export interface TickResult {
  readonly considered: number;
  readonly fired: number;
  readonly failed: number;
}

export async function tickSchedules(now = new Date()): Promise<TickResult> {
  const handle = await db();
  const schedules = await enabledSchedules(handle.db);

  let fired = 0;
  let failed = 0;

  for (const schedule of schedules) {
    try {
      fired += await fireDue(handle.db, schedule, now);
    } catch (caught) {
      failed += 1;
      // Recorded against the schedule, never rethrown: one broken schedule must
      // not stop every other workspace's from firing.
      await new ScheduleRepository(handle.db, schedule.workspaceId)
        .recordFailure(schedule._id, caught instanceof Error ? caught.message : String(caught))
        .catch(() => undefined);
    }
  }

  return { considered: schedules.length, fired, failed };
}

async function fireDue(
  database: Awaited<ReturnType<typeof db>>['db'],
  schedule: ScheduleDoc,
  now: Date,
): Promise<number> {
  const repo = new ScheduleRepository(database, schedule.workspaceId);

  // Parsed here rather than trusted from the row: the expression was validated
  // when it was written, but a row can predate a change to what is accepted,
  // and an unparseable one must disable itself rather than throw every minute.
  const fields = parseCron(schedule.expression);

  const occurrences = dueBetween(
    fields,
    schedule.timeZone,
    schedule.lastFiredFor ?? now,
    now,
    CATCH_UP_LIMIT,
  );
  if (occurrences.length === 0) return 0;

  let fired = 0;
  for (const occurrence of occurrences) {
    // Claim first. The loser of a race creates nothing.
    if (!await repo.claimOccurrence(schedule._id, occurrence)) continue;

    const runId = await startRun(database, schedule, occurrence);
    if (runId !== undefined) {
      await repo.recordRun(schedule._id, runId);
      fired += 1;
    }
  }
  return fired;
}

async function startRun(
  database: Awaited<ReturnType<typeof db>>['db'],
  schedule: ScheduleDoc,
  occurrence: Date,
): Promise<string | undefined> {
  const agent = await new AgentRepository(database, schedule.workspaceId)
    .findById(schedule.agentId);
  if (agent === null) {
    throw new Error('This schedule points at an agent that no longer exists.');
  }

  // A new conversation per occurrence, not one thread growing for ever. A daily
  // job appending to the same conversation reaches a context that costs more to
  // send than the work is worth, and compaction would be paying to summarise
  // yesterday's unrelated task.
  const conversations = new ConversationRepository(database, schedule.workspaceId);
  const conversation = await conversations.create({
    agentId: schedule.agentId,
    modelBindingId: schedule.modelBindingId,
    title: `${schedule.name} · ${occurrence.toISOString().slice(0, 16).replace('T', ' ')}`,
  });

  await conversations.appendMessage({
    conversationId: conversation._id,
    role: 'user',
    content: [{ type: 'text', text: schedule.prompt }],
    // Derived from the schedule and the occurrence, so even a claim that
    // somehow fired twice cannot append the same instruction twice.
    clientMessageId: `${schedule._id}:${occurrence.toISOString()}`,
  });

  const repos = repositories(database, schedule.workspaceId);
  const run = await repos.runs.create({
    conversationId: conversation._id,
    agentId: schedule.agentId,
    agentVersionId: agent.currentVersion.versionId,
    agentSnapshot: agent.currentVersion,
    modelBindingId: schedule.modelBindingId,
    trigger: { type: 'schedule', ref: schedule._id },
    /*
     * The schedule acts as the person who created it, with the role they had
     * when they created it — not with more. A schedule is a stored intention,
     * and it must not outlive its author's authority by becoming its own.
     */
    principal: {
      type: 'user',
      userId: asId(schedule.createdBy),
      workspaceId: asId<WorkspaceId>(schedule.workspaceId),
      role: 'member',
    },
    budget: DEFAULT_BUDGET,
    // Belt and braces with the claim: a retried tick collides here too.
    idempotencyKey: `${schedule._id}:${occurrence.toISOString()}`,
  });

  await new VercelBackgroundTrigger().trigger(asId<RunId>(run._id));
  return run._id;
}
