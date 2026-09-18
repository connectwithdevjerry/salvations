import type { ReactNode } from 'react';
import { AgentSidebar } from '@/components/agent-sidebar';

/**
 * The assistants area: the list on the left, the chosen one on the right.
 *
 * The wizard at /agents/new lives outside the (shell) group and so outside
 * this layout — creating an assistant is a full-screen moment, not a panel.
 */
export default async function AgentsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return (
    <div className="agents-shell">
      <AgentSidebar workspaceId={workspaceId} />
      <div className="agents-main">{children}</div>
    </div>
  );
}
