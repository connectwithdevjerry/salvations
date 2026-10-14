'use client';

import { useEffect, useState } from 'react';
import { api, ws } from './api';

export type PlanState = 'exempt' | 'subscribed' | 'trial' | 'trial_ended' | 'none';

export interface PlanStatus {
  configured: boolean;
  active: boolean;
  state: PlanState;
  planId?: string;
  trialDays: number;
  trialEndsAt?: string;
  canStartTrial: boolean;
}

/**
 * Whether this workspace may run assistants, from the billing route.
 *
 * `undefined` while loading. A request that fails reads as active, so a
 * hiccup on the billing route does not lock a paying workspace out of its
 * own pages; the server refuses what it must either way.
 */
export function usePlan(workspaceId: string): PlanStatus | undefined {
  const [plan, setPlan] = useState<PlanStatus>();
  useEffect(() => {
    let live = true;
    api.get<PlanStatus>(`${ws(workspaceId)}/billing`)
      .then((result) => { if (live) setPlan(result); })
      .catch(() => {
        if (live) setPlan({ configured: false, active: true, state: 'exempt', trialDays: 10, canStartTrial: false });
      });
    return () => { live = false; };
  }, [workspaceId]);
  return plan;
}

/** Days left in a trial, never below zero, rounded up so "1 day left" means today. */
export const daysLeft = (endsAt: string | undefined, now = Date.now()): number =>
  endsAt === undefined ? 0 : Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / 86_400_000));
