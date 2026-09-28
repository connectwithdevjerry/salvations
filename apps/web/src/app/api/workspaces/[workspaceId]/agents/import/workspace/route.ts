/**
 * Importing an assistant's workspace folder as a new assistant here.
 *
 * A zip of the workspace folder comes in as multipart. With `commit` unset
 * the answer is the plan: what would be made, and what would be left out.
 * With `commit=true` the assistant is created, then its memories, its
 * documents and, when a chat model is bound, a routine from the heartbeat.
 * The plan is computed the same way both times, so what was previewed is
 * what is made.
 */
import { AgentRepository, MemoryRepository, ScheduleRepository } from '@salvations/db';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { ingestDocument } from '@/lib/knowledge-service';
import { readZip, textOf } from '@/lib/zip';
import { planImport, type ImportPlan } from '@/lib/openclaw-import';
import { AGENT_COLORS } from '@/lib/agent-colors';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_ARCHIVE_BYTES = 40_000_000;

export const POST = workspaceRoute('agents:write', async (ctx) => {
  const form = await ctx.request.formData();
  const archive = form.get('archive');
  if (!(archive instanceof File) || archive.size === 0) {
    return errorResponse(422, 'validation_failed', 'Attach the zip as the "archive" field.');
  }
  if (archive.size > MAX_ARCHIVE_BYTES) {
    return errorResponse(422, 'validation_failed', 'That archive is over 40 MB. Zip the workspace folder on its own, without media.');
  }
  const commit = form.get('commit') === 'true';

  let plan: ImportPlan;
  try {
    const entries = readZip(new Uint8Array(await archive.arrayBuffer()), { maxEntryBytes: 2_000_000 });
    const files = entries
      .filter((e) => /\.(md|markdown|txt|json)$/i.test(e.path))
      .map((e) => ({ path: e.path, text: textOf(e) }));
    plan = planImport(files, archive.name.replace(/\.zip$/i, '').replace(/[-_]+/g, ' ').trim() || 'Imported assistant');
  } catch (caught) {
    return errorResponse(422, 'validation_failed', caught instanceof Error ? caught.message : 'That archive could not be read.');
  }

  const summary = {
    name: plan.name,
    emoji: plan.emoji,
    root: plan.root,
    promptChars: plan.systemPrompt.length,
    memories: plan.memories.length,
    documents: plan.documents.map((d) => d.title),
    heartbeat: plan.heartbeat !== undefined,
    skipped: plan.skipped,
  };
  if (!commit) return ok({ plan: summary });

  const actor = actorIdOf(ctx.principal);
  const agents = new AgentRepository(ctx.database, ctx.workspaceId);
  const agent = await agents.create({
    slug: plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'imported',
    name: plan.name,
    description: 'Imported from a workspace folder',
    color: AGENT_COLORS[(await agents.count()) % AGENT_COLORS.length],
    systemPrompt: plan.systemPrompt,
    modelRole: 'chat',
    createdBy: actor,
  });

  const memories = new MemoryRepository(ctx.database, ctx.workspaceId);
  let remembered = 0;
  for (const content of plan.memories) {
    try {
      await memories.remember({
        agentId: agent._id, kind: 'fact', key: undefined, content, importance: 0.6,
        sourceRunId: undefined, createdBy: actor, embeddings: undefined,
      });
      remembered += 1;
    } catch {
      // One bad line must not stop the rest.
    }
  }

  let ingested = 0;
  const failed: string[] = [];
  for (const doc of plan.documents) {
    try {
      await ingestDocument({
        database: ctx.database,
        workspaceId: ctx.workspaceId,
        title: doc.title,
        fileName: doc.fileName.endsWith('.md') ? doc.fileName : `${doc.fileName}.md`,
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode(doc.text),
        createdBy: actor,
      });
      ingested += 1;
    } catch (caught) {
      failed.push(`${doc.title}: ${caught instanceof Error ? caught.message : 'could not be added'}`);
    }
  }

  let routine: string | undefined;
  if (plan.heartbeat !== undefined) {
    const chat = await ctx.repos.models.forRole('chat');
    if (chat === null) {
      failed.push('Heartbeat: no chat model is connected yet, so no routine was made. Add one on the Models page and create the routine by hand.');
    } else {
      const created = await new ScheduleRepository(ctx.database, ctx.workspaceId).create({
        name: 'Heartbeat (imported)',
        expression: '0 8 * * *',
        timeZone: 'UTC',
        agentId: agent._id,
        modelBindingId: chat._id,
        prompt: plan.heartbeat,
        createdBy: actor,
      });
      routine = created._id;
    }
  }

  return ok({
    id: agent._id,
    name: agent.name,
    plan: summary,
    made: { memories: remembered, documents: ingested, routine },
    problems: failed,
  }, 201);
});
