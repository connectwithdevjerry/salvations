import type { ReactNode } from 'react';
import { WorkspaceNav } from '@/components/workspace-nav';
import { WalkthroughProvider } from '@/components/walkthrough';
import { PlanBanner } from '@/components/plan-banner';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <WalkthroughProvider workspaceId={workspaceId}>
      <div className="shell">
        <WorkspaceNav workspaceId={workspaceId} />
        <div className="main">
          <PlanBanner workspaceId={workspaceId} />
          {children}
        </div>
      </div>
    </WalkthroughProvider>
  );
}
