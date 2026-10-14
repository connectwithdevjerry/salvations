/**
 * The free trial.
 *
 * Ten days from the click, no card asked for, once per workspace. The
 * repository refuses a second one by construction, so a double click or a
 * replayed request changes nothing.
 */
import { TRIAL_DAYS } from '@salvations/billing';
import { AuditRepository, WorkspaceRepository } from '@salvations/db';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { entitlements } from '@/lib/billing';

export const runtime = 'nodejs';

export const POST = workspaceRoute('workspace:manage', async (ctx) => {
  const granted = await entitlements(ctx.database, ctx.workspaceId);
  if (granted.state !== 'none') {
    return errorResponse(
      409, 'conflict',
      granted.state === 'trial_ended'
        ? 'This workspace has had its free trial. Choose a plan to keep going.'
        : 'This workspace already has a plan.',
    );
  }

  const actor = actorIdOf(ctx.principal);
  const started = await new WorkspaceRepository(ctx.database).startTrial(ctx.workspaceId, actor, TRIAL_DAYS);
  if (started === undefined) {
    return errorResponse(409, 'conflict', 'This workspace has had its free trial. Choose a plan to keep going.');
  }

  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: ctx.principal.type, id: actor },
    action: 'billing.trial_started',
    subject: { type: 'workspace', id: ctx.workspaceId },
    metadata: { days: TRIAL_DAYS, endsAt: started.endsAt.toISOString() },
  });

  return ok({ state: 'trial', trialEndsAt: started.endsAt.toISOString(), trialDays: TRIAL_DAYS }, 201);
});
