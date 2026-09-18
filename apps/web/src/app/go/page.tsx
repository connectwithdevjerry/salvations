'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/client/api';

/**
 * Where a signed-in visitor actually belongs.
 *
 * Its own route rather than logic on `/` so the marketing page can be served as
 * static HTML: a page that decides where to send you cannot also be the page a
 * crawler reads. Renders nothing — it exists to redirect.
 *
 * A first visit gets a workspace made for it, named after the person, without
 * being asked. The workspace is the business context — knowledge, integrations
 * — and it exists before any agent does, so a new arrival lands on Knowledge:
 * the first thing to do is teach it what the business knows. Anyone with an
 * agent already lands in the chat.
 */
export default function Dispatch() {
  const router = useRouter();

  useEffect(() => {
    api.get<{ items: { id: string }[] }>('/api/workspaces')
      .then(async (result) => {
        const existing = result.items[0];
        if (existing !== undefined) return existing.id;
        const created = await api.post<{ id: string }>('/api/workspaces', {});
        return created.id;
      })
      .then(async (workspaceId) => {
        const agents = await api.get<{ items: unknown[] }>(`/api/workspaces/${workspaceId}/agents`)
          .then((r) => r.items.length)
          .catch(() => 0);
        router.replace(agents === 0 ? `/w/${workspaceId}/knowledge` : `/w/${workspaceId}/chat`);
      })
      .catch((caught: unknown) => {
        router.replace(caught instanceof ApiError && caught.status === 401 ? '/signin' : '/');
      });
  }, [router]);

  return <div className="centered" />;
}
