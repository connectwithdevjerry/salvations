'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { formatPrice, type Plan } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { BrandMark, Icon, TickList } from '@/components/ui';

/**
 * The plan.
 *
 * Card details never touch this page. The Subscribe button starts a session
 * with the processor and sends the browser there; what comes back is an
 * identifier. That is not squeamishness — accepting a card number anywhere in
 * this codebase would put the whole system in PCI-DSS scope, and no amount of
 * care here would take it back out.
 *
 * When no processor is configured the page says so plainly rather than showing
 * a button that cannot work. A private install charging nobody is a normal
 * thing to be.
 */

interface Billing {
  configured: boolean;
  plans: Plan[];
  active: boolean;
  planId?: string;
  subscription?: { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd?: string };
}

export default function BillingPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(params);
  const [billing, setBilling] = useState<Billing>();
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api.get<Billing>(`${ws(workspaceId)}/billing`)
      .then(setBilling)
      .catch((e: Error) => setError(e.message));
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  if (billing === undefined) {
    return <div className="page"><p className="muted">{error ?? 'Loading…'}</p></div>;
  }

  if (!billing.configured) {
    return (
      <div className="page">
        <header>
          <h2>Billing</h2>
          <p className="lede">This deployment has no payment processor configured.</p>
        </header>
        <div className="note">
          <span className="tile" aria-hidden><Icon name="shield" size={16} /></span>
          <span>
            Nothing here is charged and nothing is limited. Set{' '}
            <span className="mono">STRIPE_SECRET_KEY</span>,{' '}
            <span className="mono">STRIPE_WEBHOOK_SECRET</span> and{' '}
            <span className="mono">STRIPE_PRICE_ID</span> together to turn billing on.
          </span>
        </div>
      </div>
    );
  }

  const plan = billing.plans[0];
  if (plan === undefined) {
    return <div className="page"><p className="muted">No plan is defined.</p></div>;
  }

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <header>
        <h2>{billing.active ? 'Your plan' : 'Bring your agents online'}</h2>
        <p className="lede">{plan.tagline}</p>
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

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em' }}>
            {formatPrice(plan)}
          </span>
          <span className="muted">/ {plan.interval}</span>
          <span className="badge">cancel anytime</span>
        </div>

        <TickList items={plan.features} />

        {billing.active ? (
          <ActiveSubscription
            workspaceId={workspaceId}
            billing={billing}
            onChanged={reload}
            onError={setError}
          />
        ) : (
          <div className="wizard-foot">
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontWeight: 400, margin: 0 }}>
              <input
                type="checkbox" style={{ width: 'auto', marginTop: 3 }}
                checked={agreed} onChange={(e) => setAgreed(e.target.checked)}
              />
              <span className="muted">
                I agree to the terms of service and privacy policy.
              </span>
            </label>
            <button
              className="primary lg"
              type="button"
              // Unchecked is not a validation error to explain afterwards; the
              // button simply is not available yet.
              disabled={busy || !agreed}
              onClick={async () => {
                setBusy(true);
                setError(undefined);
                try {
                  const { url } = await api.post<{ url: string }>(`${ws(workspaceId)}/billing`);
                  // A full navigation. The processor hosts the form, and this
                  // page never sees a card number.
                  window.location.assign(url);
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Could not start checkout.');
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Opening checkout…' : 'Subscribe'} <Icon name="arrow" size={16} />
            </button>
          </div>
        )}
      </div>

      <p className="faint" style={{ marginTop: 14 }}>
        Payment is handled entirely by the processor. No card details reach this application,
        and none are stored here.
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
            <strong>A payment did not go through.</strong> Nothing has stopped — the processor
            is still retrying. Update the card on file before the retries run out.
          </span>
        </div>
      )}

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
            Cancel subscription
          </button>
        </div>
      )}
    </div>
  );
}
