'use client';

import { use } from 'react';
import { KnowledgePanel } from '@/components/knowledge-panel';

export default function KnowledgePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <KnowledgePanel workspaceId={workspaceId} />;
}
