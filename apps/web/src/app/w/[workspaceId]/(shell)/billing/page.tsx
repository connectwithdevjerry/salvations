'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatPrice, type Plan } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { BrandMark, Icon, TickList } from '@/components/ui';
import { daysLeft, type PlanState } from '@/lib/client/use-plan';

/**
 * The plan.
 *
 * Two ways in: a free trial, ten days from the click with no card asked for,
 * or a subscription. Card details never touch this page. The Subscribe button
 * starts a session with the processor and sends the browser there; what comes
 * back is an identifier. Accepting a card number anywhere in this codebase
 * would put the whole system in PCI-DSS scope, and no amount of care here
 * would take it back out.
 *
 * `?then=team` or `?then=new` says where the person was going: a trial that
 * starts sends them straight on to make their assistants.
 */

interface Billing {
  configured: boolean;
  plans: Plan[];
  active: boolean;
  state: PlanState;
  planId?: string;
  trialDays: number;
  trialEndsAt?: string;
  canStartTrial: boolean;
  subscription?: { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd?: string };
}

export default function BillingPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(params);
  const router = useRouter();
  const [then, setThen] = useState<string | null>(null);
  const [billing, setBilling] = useState<Billing>();
  const [busy, setBusy] = useState<'trial' | 'checkout'>();
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api.get<Billing>(`${ws(workspaceId)}/billing`)
      .then(setBilling)
      .catch((e: Error) => setError(e.message));
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setThen(new URLSearchParams(window.location.search).get('then')); }, []);

  if (billing === undefined) {
    return <div className="page"><p className="muted">{error ?? 'Loading…'}</p></div>;
  }

  const plan = billing.plans[0];
  if (plan === undefined) {
    return <div className="page"><p className="muted">No plan is defined.</p></div>;
  }

  const onward = () => {
    if (then === 'team' || then === 'new') router.push(`/w/${workspaceId}/agents/${then}`);
    else reload();
  };

  async function startTrial() {
    setBusy('trial');
    setError(undefined);
    try {
      await api.post(`${ws(workspaceId)}/billing/trial`);
      onward();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the trial.');
      setBusy(undefined);
    }
  }

  async function subscribe() {
    setBusy('checkout');
    setError(undefined);
    try {
      const { url } = await api.post<{ url: string }>(`${ws(workspaceId)}/billing`);
      // A full navigation. The processor hosts the form, and this page never
      // sees a card number.
      window.location.assign(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start checkout.');
      setBusy(undefined);
    }
  }

  const remaining = daysLeft(billing.trialEndsAt);
  const subscribed = billing.state === 'subscribed' || billing.state === 'exempt';

  const heading = billing.state === 'subscribed' ? 'Your plan'
    : billing.state === 'exempt' ? 'Your plan'
    : billing.state === 'trial' ? `${remaining} ${remaining === 1 ? 'day' : 'days'} left in your free trial`
    : billing.state === 'trial_ended' ? 'Your free trial has ended'
    : `Try YASHAYAH free for ${billing.trialDays} days`;

  const lede = billing.state === 'trial'
    ? `Everything is on until ${new Date(billing.trialEndsAt ?? 0).toLocaleDateString()}. Subscribe any time to keep it that way.`
    : billing.state === 'trial_ended' ? 'Your assistants and everything they know are still here. Subscribe to bring them back online.'
    : billing.state === 'none' ? 'No card needed. Build your team, connect your tools, see what they can do. Then decide.'
    : plan.tagline;

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <header>
        <h2>{heading}</h2>
        <p className="lede">{lede}</p>
      </header>

      {error !== undefined && <p className="error">{error}</p>}

      <div className="panel">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
          <BrandMark wordmark={false} />
          <div>
            <strong style={{ fontSize: 16 }}>{plan.name}</strong>
            <p className="muted" style={{ margin: '2px 0 0' }}>{plan.tagline}</p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em' }}>
            {formatPrice(plan)}
          </span>
          <span className="muted">/ {plan.interval}</span>
          {billing.canStartTrial && <span className="badge accent">{billing.trialDays} days free first</span>}
          <span className="badge">cancel anytime</span>
        </div>

        <TickList items={plan.features} />

        {billing.state === 'exempt' && (
          <p className="muted" style={{ marginTop: 16 }}>
            This workspace is on the house. Nothing is counted and nothing is charged.
          </p>
        )}

        {billing.state === 'subscribed' ? (
          <ActiveSubscription
            workspaceId={workspaceId}
            billing={billing}
            onChanged={reload}
            onError={setError}
          />
        ) : !subscribed && (
          <div className="wizard-foot" style={{ flexWrap: 'wrap', gap: 12 }}>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontWeight: 400, margin: 0, flex: '1 1 260px' }}>
              <input
                type="checkbox" style={{ width: 'auto', marginTop: 3 }}
                checked={agreed} onChange={(e) => setAgreed(e.target.checked)}
              />
              <span className="muted">
                I agree to the <a href="/terms" target="_blank" rel="noreferrer">terms of service</a> and{' '}
                <a href="/privacy" target="_blank" rel="noreferrer">privacy policy</a>.
              </span>
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {billing.canStartTrial && (
                <button
                  className="primary lg" type="button"
                  // Unchecked is not a validation error to explain afterwards;
                  // the button simply is not available yet.
                  disabled={busy !== undefined || !agreed}
                  onClick={() => void startTrial()}
                >
                  {busy === 'trial' ? 'Starting…' : 'Start the free trial'} <Icon name="arrow" size={16} />
                </button>
              )}
              {billing.configured ? (
                <button
                  className={billing.canStartTrial ? 'lg' : 'primary lg'} type="button"
                  disabled={busy !== undefined || !agreed}
                  onClick={() => void subscribe()}
                >
                  {busy === 'checkout' ? 'Opening checkout…' : 'Subscribe'} <Icon name="arrow" size={16} />
                </button>
              ) : (
                <button className="lg" type="button" disabled title="Card payments are not open yet">
                  Subscribe
                </button>
              )}
            </div>
            {!billing.configured && (
              <p className="faint" style={{ margin: 0, flexBasis: '100%' }}>
                Card payments are not open on this deployment yet.
                {' '}Whoever runs it sets <span className="mono">STRIPE_SECRET_KEY</span>,{' '}
                <span className="mono">STRIPE_WEBHOOK_SECRET</span> and <span className="mono">STRIPE_PRICE_ID</span> together to open them.
              </p>
            )}
          </div>
        )}
      </div>

      <p className="faint" style={{ marginTop: 14 }}>
        Payment is handled entirely by the processor. No card details reach this application,
        and none are stored here. A trial asks for no card at all.
      </p>
    </div>
  );
}

function ActiveSubscription({
  workspaceId, billing, onChanged, onError,
}: {
  workspaceId: string;
  billing: Billing;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const subscription = billing.subscription;
  const endsAt = subscription?.currentPeriodEnd;

  return (
    <div style={{ marginTop: 20 }}>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`badge ${subscription?.status === 'past_due' ? 'warn' : 'ok'}`}>
              {subscription?.status ?? 'active'}
            </span>
          </dd>
        </div>
        {endsAt !== undefined && (
          <div>
            <dt>{subscription?.cancelAtPeriodEnd === true ? 'Ends' : 'Renews'}</dt>
            <dd>{new Date(endsAt).toLocaleDateString()}</dd>
          </div>
        )}
      </dl>

      {subscription?.status === 'past_due' && (
        <div className="note" style={{ marginTop: 14 }}>
          <span className="tile" aria-hidden><Icon name="shield" size={16} /></span>
          <span>
            <strong>A payment did not go through.</strong> Nothing has stopped: the processor
            is still retrying. Update the card on file before the retries run out.
          </span>
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-start', gap: 8, marginTop: 14 }}>
        <button
          type="button" disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { url } = await api.post<{ url: string }>(`${ws(workspaceId)}/billing/portal`);
              window.location.assign(url);
            } catch (caught) {
              onError(caught instanceof Error ? caught.message : 'Could not open the billing portal.');
              setBusy(false);
            }
          }}
        >
          Change card or see invoices
        </button>
        <span className="faint">Opens the processor&apos;s own page. You come back here when done.</span>
      </div>

      {subscription?.cancelAtPeriodEnd !== true && (
        <div className="wizard-foot">
          <span className="faint">You keep everything until the period ends.</span>
          <button
            type="button" className="danger" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.del(`${ws(workspaceId)}/billing`);
                onChanged();
              } catch (caught) {
                onError(caught instanceof Error ? caught.message : 'Could not cancel.');
              } finally { setBusy(false); }
            }}
          >
            Cancel at period end
          </button>
        </div>
      )}
    </div>
  );
}
