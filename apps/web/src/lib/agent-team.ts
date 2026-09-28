/**
 * Making an assistant with a job.
 *
 * One path for the wizard's role picker and the team page: the role writes
 * itself into the instructions under the business's name, the assistant is
 * filed under the team, and the role's routines are created when there is a
 * chat model to run them. Without one they are simply not made, and the
 * caller says so, rather than a routine that fires into nothing.
 */
import { AgentRepository, ScheduleRepository, WorkspaceRepository } from '@salvations/db';
import { TEAM_GROUP, roleSystemPrompt, type AssistantRole } from '@salvations/catalog';
import type { WorkspaceContext } from './route';

export interface MadeAssistant {
  readonly id: string;
  readonly name: string;
  readonly routines: number;
}

export async function createAssistantFromRole(
  ctx: Pick<WorkspaceContext, 'database' | 'workspaceId' | 'repos'>,
  role: AssistantRole,
  input: { name?: string | undefined; category?: string | undefined; createdBy: string },
): Promise<MadeAssistant> {
  const agents = new AgentRepository(ctx.database, ctx.workspaceId);
  const name = (input.name ?? role.assistantName).trim() || role.assistantName;
  const businessName = (await new WorkspaceRepository(ctx.database).findById(ctx.workspaceId))?.name;

  const agent = await agents.create({
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || role.id,
    name,
    description: role.summary,
    category: input.category === undefined || input.category === '' ? TEAM_GROUP : input.category,
    color: role.color,
    systemPrompt: roleSystemPrompt(role, { assistantName: name, businessName }),
    modelRole: 'chat',
    createdBy: input.createdBy,
  });

  let routines = 0;
  const chat = await ctx.repos.models.forRole('chat');
  if (chat !== null) {
    const schedules = new ScheduleRepository(ctx.database, ctx.workspaceId);
    for (const routine of role.routines) {
      await schedules.create({
        name: routine.name,
        expression: routine.expression,
        timeZone: 'UTC',
        agentId: agent._id,
        modelBindingId: chat._id,
        prompt: routine.prompt,
        createdBy: input.createdBy,
      });
      routines += 1;
    }
  }

  return { id: agent._id, name: agent.name, routines };
}
