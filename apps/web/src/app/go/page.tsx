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
 */
export default function Dispatch() {
  const router = useRouter();

  useEffect(() => {
    api.get<{ items: { id: string }[] }>('/api/workspaces')
      .then((result) => {
        const first = result.items[0];
        router.replace(first === undefined ? '/onboarding' : `/w/${first.id}/chat`);
      })
      .catch((caught: unknown) => {
        router.replace(caught instanceof ApiError && caught.status === 401 ? '/signin' : '/');
      });
  }, [router]);

  return <div className="centered" />;
}
