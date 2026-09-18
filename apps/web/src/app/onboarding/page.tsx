'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Kept for old links. Setup now happens inside the workspace: knowledge and
 * integrations first, then "Create agent" on the Agents page opens the wizard.
 */
export default function OnboardingRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/go'); }, [router]);
  return <div className="centered" />;
}
