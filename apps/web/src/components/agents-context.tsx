'use client';

import { createContext, useContext } from 'react';

export interface AgentRow {
  id: string; name: string; category?: string; color: string; main: boolean;
  status: 'running' | 'failed' | 'idle';
  lastMessage?: { preview: string; at: string };
  createdAt: string;
}

/**
 * The assistants, fetched once for the whole area.
 *
 * The sidebar and the chosen assistant's header both need the same list;
 * fetching it twice — and polling it twice — was two requests where one does.
 * The sidebar owns the fetch and shares it here.
 */
export interface AgentsState {
  readonly agents: AgentRow[] | undefined;
  readonly reload: () => void;
}

export const AgentsContext = createContext<AgentsState>({ agents: undefined, reload: () => undefined });

export const useAgents = (): AgentsState => useContext(AgentsContext);
