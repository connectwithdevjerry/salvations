'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader } from '@/components/loader';

/** Kept for old links. Chat lives under each assistant now. */
export default function ChatRedirect({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const router = useRouter();
  useEffect(() => { router.replace(`/w/${workspaceId}/agents`); }, [router, workspaceId]);
  return <div className="centered"><Loader /></div>;
}
