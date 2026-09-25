/**
 * The run timeline.
 *
 * Steps, tool calls, usage and cost as they were recorded — not reconstructed
 * from events. An event stream is for watching; this is for explaining what
 * happened afterwards, including to someone asking why a run cost what it did.
 */
import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ runId: string }>('runs:read', async (ctx, params) => {
  const steps = await ctx.repos.runs.listSteps(params.runId);

  return ok({
    items: steps.map((step) => ({
      seq: step.seq,
      type: step.type,
      status: step.status,
      usage: step.usage ?? undefined,
      latencyMs: step.latencyMs ?? undefined,
      toolCalls: (step.toolCalls ?? []).map((call) => ({
        id: call.id,
        capabilityName: call.canonicalName,
        isError: call.isError,
        durationMs: call.durationMs,
        mrtrRounds: call.mrtrRounds,
        // Reported as recorded. A missing decision reads as unknown rather than
        // as 'allow': inventing a permissive default is how a reviewer ends up
        // reading something that never happened.
        permission: call.permission ?? undefined,
        // Redacted at WRITE time, not here: a display-time redaction is one
        // forgotten call site from a leak.
        argumentsRedacted: call.argumentsRedacted,
      })),
      error: step.error ?? undefined,
      startedAt: step.startedAt?.toISOString(),
      finishedAt: step.finishedAt?.toISOString(),
    })),
  });
});
