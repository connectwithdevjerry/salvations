import type { ReactNode } from 'react';
import { VerifyGate } from '@/components/verify-gate';

/** Every workspace page, the shell and the full-screen ones alike, waits for a confirmed address. */
export default function WorkspaceGateLayout({ children }: { children: ReactNode }) {
  return <VerifyGate>{children}</VerifyGate>;
}
