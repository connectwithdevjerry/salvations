'use client';

import { createContext, useContext } from 'react';

/**
 * What an assistant is up to, from its latest run. Shown as a colour, never as
 * a word next to the name: the panel is a list of people to talk to, not a
 * process monitor.
 */
export type AgentStatus = 'working' | 'waiting' | 'failed' | 'idle';

export const STATUS_COPY: Readonly<Record<AgentStatus, string>> = {
  working: 'Working on a reply',
  waiting: 'Waiting for you to approve something',
  failed: 'The last reply failed',
  idle: 'Idle',
};

export interface AgentRow {
  id: string; name: string; category?: string; color: string; main: boolean;
  status: AgentStatus;
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
