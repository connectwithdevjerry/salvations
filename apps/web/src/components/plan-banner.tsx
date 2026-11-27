'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { daysLeft, usePlan } from '@/lib/client/use-plan';

/**
 * A line across the top of every workspace page when the plan is the reason
 * something will not work: the trial has ended, or was never started, or ends
 * within a day. Without it, a paused workspace looked like a broken one.
 *
 * The warning that a trial is ending can be put away for the visit; the two
 * that mean nothing will run cannot. Not shown on the Billing page, which is
 * where every one of them points.
 */
export function PlanBanner({ workspaceId }: { workspaceId: string }) {
  const plan = usePlan(workspaceId);
  const pathname = usePathname();
  const dismissKey = `plan-banner:${workspaceId}`;
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try { setDismissed(sessionStorage.getItem(dismissKey) === '1'); } catch { /* storage refused: show it */ }
  }, [dismissKey]);

  if (plan === undefined || pathname.endsWith('/billing')) return null;
  const billing = `/w/${workspaceId}/billing`;

  if (!plan.active && plan.state === 'trial_ended') {
    return (
      <Banner tone="error" action={<Link href={billing}>Choose a plan</Link>}>
        <strong>Your free trial has ended.</strong> Your assistants are paused, and won’t answer here or on your
        channels, until you choose a plan.
      </Banner>
    );
  }
  if (!plan.active && plan.state === 'none') {
    return (
      <Banner tone="warn" action={<Link href={billing}>Start the free trial</Link>}>
        <strong>Your assistants can’t run yet.</strong> Start your {plan.trialDays}-day free trial, no card
        needed, or choose a plan.
      </Banner>
    );
  }
  if (plan.state === 'trial' && !dismissed) {
    const left = daysLeft(plan.trialEndsAt);
    if (left <= 1) {
      return (
        <Banner
          tone="warn"
          action={<Link href={billing}>Choose a plan</Link>}
          onDismiss={() => {
            setDismissed(true);
            try { sessionStorage.setItem(dismissKey, '1'); } catch { /* the dismissal lasts this render only */ }
          }}
        >
          <strong>Your free trial ends {left === 0 ? 'today' : 'tomorrow'}.</strong> Choose a plan to keep your
          assistants working without a break.
        </Banner>
      );
    }
  }
  return null;
}

function Banner({ tone, action, onDismiss, children }: {
  tone: 'error' | 'warn';
  action: React.ReactNode;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`plan-banner ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <p>{children}</p>
      <span className="plan-banner-action">{action}</span>
      {onDismiss !== undefined && (
        <button type="button" className="plan-banner-close" aria-label="Dismiss" onClick={onDismiss}>×</button>
      )}
    </div>
  );
}
