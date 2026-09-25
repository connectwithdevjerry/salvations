/** Pausing, resuming and deleting a schedule. */
import { z } from 'zod';
import { ScheduleRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

const patchSchema = z.object({ enabled: z.boolean() });

export const PATCH = workspaceRoute<{ scheduleId: string }>(
  'agents:write',
  async (ctx, params) => {
    const input = await jsonBody(ctx.request, patchSchema);
    const repo = new ScheduleRepository(ctx.database, ctx.workspaceId);

    if (await repo.findById(params.scheduleId) === null) {
      return errorResponse(404, 'not_found', 'That schedule does not exist.');
    }

    await repo.setEnabled(params.scheduleId, input.enabled);
    return ok({ enabled: input.enabled });
  },
);

export const DELETE = workspaceRoute<{ scheduleId: string }>(
  'agents:write',
  async (ctx, params) => {
    await new ScheduleRepository(ctx.database, ctx.workspaceId).remove(params.scheduleId);
    // 200 whether or not it was there. Deleting something already gone is the
    // outcome the caller wanted.
    return ok({ deleted: true });
  },
);
