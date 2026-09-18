/**
 * Servers we wrote, presented as bindings.
 *
 * Synthesised rather than stored. A first-party server is not installed — it is
 * always present in every workspace, and a row somebody could delete or
 * misconfigure would be a row that eventually IS deleted or misconfigured, at
 * which point an agent quietly loses its memory with nothing to explain why.
 *
 * They are `first_party` trust, which is a CEILING on what they may ask the
 * host for, not a licence. They still go through the gateway, still get
 * validated, still get audited. What the tier buys them is capability
 * auto-approval, because their definitions change on deploy rather than under
 * us — see the reconcile comment for why that distinction is the whole basis
 * of the approval mechanism.
 */
import type { BindingRecord, ServerRecord } from '@salvations/mcp';

export interface FirstPartyBinding {
  readonly binding: BindingRecord;
  readonly server: ServerRecord;
}

/** Stable ids. They appear on capability rows, so changing one is a migration. */
export const MEMORY_BINDING_ID = 'mcb_first_party_memory';
export const CONVERSATION_BINDING_ID = 'mcb_first_party_conversation';
export const KNOWLEDGE_BINDING_ID = 'mcb_first_party_knowledge';

const MEMORY_SERVER_ID = 'mcs_first_party_memory';
const CONVERSATION_SERVER_ID = 'mcs_first_party_conversation';
const KNOWLEDGE_SERVER_ID = 'mcs_first_party_knowledge';

/**
 * The aliases prefix every tool name — `memory__recall`, `chat__recall`.
 *
 * "chat" rather than "conversation" so the two do not both start with the same
 * several characters in a list a model is scanning.
 */
export const MEMORY_ALIAS = 'memory';
export const CONVERSATION_ALIAS = 'chat';
export const KNOWLEDGE_ALIAS = 'knowledge';

function binding(id: string, serverId: string, alias: string): FirstPartyBinding {
  return {
    binding: {
      id,
      workspaceId: '',
      mcpServerId: serverId,
      alias,
      enabled: true,
      status: 'connected',
      // Never per-user. These are scoped by the run that built them, and a
      // per-user flag would add an OAuth dance to a server that has no auth.
      perUserAuth: false,
    },
    server: {
      id: serverId,
      slug: alias,
      transport: 'in_process',
      authMode: 'none',
      trustTier: 'first_party',
    },
  };
}

/** Every first-party binding, stamped with the workspace asking. */
export function firstPartyBindings(workspaceId: string): readonly FirstPartyBinding[] {
  return [
    binding(MEMORY_BINDING_ID, MEMORY_SERVER_ID, MEMORY_ALIAS),
    binding(CONVERSATION_BINDING_ID, CONVERSATION_SERVER_ID, CONVERSATION_ALIAS),
    binding(KNOWLEDGE_BINDING_ID, KNOWLEDGE_SERVER_ID, KNOWLEDGE_ALIAS),
  ].map((entry) => ({
    ...entry,
    binding: { ...entry.binding, workspaceId },
  }));
}

const FIRST_PARTY_IDS: ReadonlySet<string> = new Set([
  MEMORY_BINDING_ID, CONVERSATION_BINDING_ID, KNOWLEDGE_BINDING_ID,
]);

export const isFirstParty = (bindingId: string): boolean => FIRST_PARTY_IDS.has(bindingId);
