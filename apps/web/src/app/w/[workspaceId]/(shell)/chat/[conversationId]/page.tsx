'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, ws } from '@/lib/client/api';

/** Kept for old links: a conversation now lives under its assistant. */
export default function ConversationRedirect({
  params,
}: {
  params: Promise<{ workspaceId: string; conversationId: string }>;
}) {
  const { workspaceId, conversationId } = use(params);
  const router = useRouter();

  useEffect(() => {
    api.get<{ items: { id: string; agentId: string }[] }>(`${ws(workspaceId)}/conversations`)
      .then((r) => {
        const found = r.items.find((c) => c.id === conversationId);
        router.replace(found === undefined
          ? `/w/${workspaceId}/agents`
          : `/w/${workspaceId}/agents/${found.agentId}?c=${conversationId}`);
      })
      .catch(() => router.replace(`/w/${workspaceId}/agents`));
  }, [router, workspaceId, conversationId]);

  return <div className="centered" />;
}
