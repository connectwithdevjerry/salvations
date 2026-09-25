/**
 * Approving capabilities.
 *
 * The reviewer sends back the hashes they were SHOWN. If a server changed a
 * tool between the page rendering and the click, the hashes disagree and the
 * approval is refused — so an approval always applies to the definition a
 * person actually read, not to whatever the server is serving now.
 *
 * This is the same rug-pull defence the gateway enforces at call time, moved
 * one step earlier so it is caught by a person rather than by a refusal.
 */
import { approveCapabilitiesSchema } from '@salvations/contracts';
import { capabilityToDomain } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

export const POST = workspaceRoute('mcp:approve', async (ctx) => {
  const input = await jsonBody(ctx.request, approveCapabilitiesSchema);

  const docs = await ctx.repos.capabilities.findByIds(input.capabilityIds);
  const found = new Map(docs.map((d) => [d._id, capabilityToDomain(d)]));

  const missing = input.capabilityIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return errorResponse(404, 'not_found', 'Some capabilities no longer exist.', { missing });
  }

  const moved = [...found.values()].filter(
    (cap) => input.expectedHashes[cap.id] !== cap.definitionHash,
  );
  if (moved.length > 0) {
    return errorResponse(
      409, 'capability_changed',
      'These tools changed since the page was loaded. Review the new definitions before ' +
        'approving them.',
      { changed: moved.map((c) => c.canonicalName) },
    );
  }

  const result = await ctx.repos.capabilities.approveMany(
    input.expectedHashes, actorIdOf(ctx.principal),
  );

  // A capability that moved between the check above and the write is SKIPPED
  // and reported rather than forced: the guard is per capability precisely so
  // one late change cannot ride in on the others' approval.
  return ok({ approved: result.approved.length, skipped: result.skipped });
});
