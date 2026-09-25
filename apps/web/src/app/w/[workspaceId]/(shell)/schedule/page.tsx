'use client';

import { use } from 'react';
import { SchedulePanel } from '@/components/schedule-panel';

export default function SchedulePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <SchedulePanel workspaceId={workspaceId} />;
}
