'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Kept for old links. Integrations belong to each assistant now. */
export default function IntegrationsRedirect({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const router = useRouter();
  useEffect(() => { router.replace(`/w/${workspaceId}/agents`); }, [router, workspaceId]);
  return <div className="centered" />;
}
