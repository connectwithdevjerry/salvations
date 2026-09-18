import type { ReactNode } from 'react';
import { WorkspaceNav } from '@/components/workspace-nav';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="shell">
      <WorkspaceNav workspaceId={workspaceId} />
      <div className="main">{children}</div>
    </div>
  );
}
