/**
 * Which model an assistant thinks with.
 *
 * The assistant's own choice first — made on its Model tab and stored on the
 * agent — as long as that binding still exists and is enabled. Failing that,
 * whatever serves the role the assistant names, which is how it worked
 * before there was a choice, and what a fresh assistant still gets.
 *
 * One definition, used by the chat, the Telegram path, the assistant server,
 * the surface and readiness, so all of them agree on the answer.
 */
import type { AgentDoc, ModelBindingDoc, ModelBindingRepository } from '@salvations/db';

export async function modelForAgent(
  models: ModelBindingRepository,
  agent: Pick<AgentDoc, 'modelBindingId' | 'currentVersion'>,
): Promise<ModelBindingDoc | null> {
  if (agent.modelBindingId != null) {
    const chosen = await models.findById(agent.modelBindingId);
    if (chosen !== null && chosen.enabled) return chosen;
  }
  return models.forRole(agent.currentVersion.modelRole);
}
