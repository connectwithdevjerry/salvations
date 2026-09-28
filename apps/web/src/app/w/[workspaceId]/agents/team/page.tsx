'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CORE_ROLE_IDS, ROLES } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { BrandMark, Icon, Tile } from '@/components/ui';

/**
 * Starting with a team.
 *
 * Tick the jobs, press once. Each becomes an assistant with its role written
 * in and its routines ready, all filed under Team. The five most businesses
 * want are ticked already.
 */
export default function TeamPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const router = useRouter();
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(CORE_ROLE_IDS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const toggle = (id: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="wizard">
      <div className="wizard-bar">
        <BrandMark wordmark={false} />
        <span />
        <button className="ghost" type="button" aria-label="Back to the workspace" onClick={() => router.push(`/w/${workspaceId}/agents`)}>
          <Icon name="exit" size={17} />
        </button>
      </div>
      <div className="wizard-body wide">
        <div className="wizard-head">
          <Tile name="agent" large />
          <div>
            <h2>Start with a team</h2>
            <p>
              Each one is an assistant with a job: what it looks after, what it does on its own, and how
              to start talking to it. They all share what the workspace knows. Untick what you do not need.
            </p>
          </div>
        </div>
        {error !== undefined && <p className="error">{error}</p>}

        <div className="role-grid">
          {ROLES.map((role) => {
            const on = chosen.has(role.id);
            return (
              <button
                key={role.id} type="button" className={on ? 'role-card on' : 'role-card'}
                aria-pressed={on} onClick={() => toggle(role.id)}
              >
                <span className="role-swatch" style={{ background: role.color }} aria-hidden />
                <span className="role-name">{role.name}</span>
                <span className="role-summary">{role.summary}</span>
                <span className="role-tick" aria-hidden><Icon name="check" size={13} /></span>
              </button>
            );
          })}
        </div>

        <div className="wizard-foot">
          <span className="faint">{chosen.size} {chosen.size === 1 ? 'assistant' : 'assistants'}. Routines switch on once a model is connected.</span>
          <button
            className="primary" type="button" disabled={busy || chosen.size === 0}
            onClick={async () => {
              setBusy(true); setError(undefined);
              try {
                await api.post(`${ws(workspaceId)}/agents/team`, { roleIds: [...chosen] });
                router.push(`/w/${workspaceId}/agents`);
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'Could not create the team.');
                setBusy(false);
              }
            }}
          >
            {busy ? 'Creating…' : `Create ${chosen.size === 1 ? 'this assistant' : `these ${chosen.size}`}`} <Icon name="arrow" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
