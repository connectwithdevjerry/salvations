/**
 * What the installed servers offer, and whether it may be used.
 *
 * `blockedReason` is computed here from the same predicate the gateway uses, so
 * the UI and the enforcement point cannot disagree about whether a tool is
 * callable. A second implementation of that rule is a second answer to it.
 */
import { capabilityBlockReason, isCapabilityUsable } from '@salvations/core';
import { capabilityToDomain } from '@salvations/db';
import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = workspaceRoute('mcp:read', async (ctx) => {
  const url = new URL(ctx.request.url);
  const scopeKeys = ['workspace'];
  const userScope = url.searchParams.get('scopeKey');
  if (userScope !== null && userScope !== 'workspace') scopeKeys.push(userScope);

  const docs = await ctx.repos.capabilities.listForScope(scopeKeys);

  return ok({
    items: docs.map(capabilityToDomain).map((cap) => ({
      id: cap.id,
      bindingId: cap.bindingId,
      kind: cap.kind,
      name: cap.name,
      canonicalName: cap.canonicalName,
      title: cap.title,
      description: cap.description,
      inputSchema: cap.inputSchema,
      annotations: cap.annotations,
      definitionHash: cap.definitionHash,
      approval: {
        state: cap.approval.state,
        definitionHash: cap.approval.definitionHash,
        approvedAt: cap.approval.approvedAt?.toISOString(),
      },
      usable: isCapabilityUsable(cap),
      blockedReason: capabilityBlockReason(cap),
    })),
  });
});
