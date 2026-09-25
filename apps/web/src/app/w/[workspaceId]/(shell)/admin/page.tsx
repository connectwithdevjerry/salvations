'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ws, ApiError } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { SkeletonPage } from '@/components/skeleton';
import { Copyable } from '@/components/setup-steps';
import { useDialog } from '@/components/dialog';
import { ago } from '@/components/agent-sidebar';

/**
 * The owner's dashboard.
 *
 * What it costs, whether anything is stuck, who is in here, and the knobs.
 * Everything on it answers a question an owner asks on opening the product
 * in the morning; nothing on it is a chart for its own sake.
 *
 * Visible to owners and admins only. The rail hides the entry for everyone
 * else, and the server refuses them anyway.
 */

interface Overview {
  workspace: { name: string; plan: string; createdAt?: string; settings?: Settings };
  counts: {
    assistants: number; members: number; owners: number; invitations: number;
    channels: number; providers: number; pendingApprovals: number;
  };
  spend: {
    todayUsd: number; dailyCapUsd: number; windowUsd: number;
    byDay: { day: string; costUsd: number }[];
    byModel: { id: string; name: string; costUsd: number; runs: number }[];
  };
  runs: {
    windowDays: number; total: number; byStatus: Record<string, number>;
    byAgent: { id: string; name: string; runs: number; costUsd: number; failed: number }[];
  };
  audit: { id: string; action: string; actor: { type: string; id?: string | null }; subject: { type: string; id?: string | null }; at: string }[];
}

interface Settings { dailyCostCapUsd: number; maxConcurrentRuns: number; defaultToolEffect: 'allow' | 'ask' | 'deny' }

type Role = 'owner' | 'admin' | 'member' | 'viewer';
interface Member { userId: string; role: Role; status: string; joinedAt: string; name?: string; email?: string; you: boolean }
interface Invitation { id: string; email: string; role: Role; expiresAt: string }

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including billing and deleting the workspace.',
  admin: 'Runs the workspace: assistants, keys, integrations, members.',
  member: 'Chats, uploads documents, approves actions.',
  viewer: 'Looks, and changes nothing.',
};

/** "5 days", "1 day", or "a few hours" once it is closer than that. */
function daysUntil(iso: string): string {
  const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
  return days <= 0 ? 'a few hours' : days === 1 ? '1 day' : `${days} days`;
}

const usd = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`;

export default function AdminPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api.get<Overview>(`${ws(workspaceId)}/admin`)
      .then(setOverview)
      .catch((caught: unknown) => setError(
        caught instanceof ApiError && caught.status === 403
          ? 'This page is for owners and admins.'
          : caught instanceof Error ? caught.message : 'Could not load the overview.',
      ));
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  if (error !== undefined) return <div className="page"><p className="error">{error}</p></div>;
  if (overview === undefined) return <div className="page"><SkeletonPage blocks={4} /></div>;

  const { counts, spend, runs } = overview;
  const capUsed = spend.dailyCapUsd > 0 ? spend.todayUsd / spend.dailyCapUsd : 0;
  const failed = runs.byStatus['failed'] ?? 0;
  const succeeded = runs.byStatus['succeeded'] ?? 0;
  const waiting = (runs.byStatus['awaiting_approval'] ?? 0) + (runs.byStatus['awaiting_input'] ?? 0);

  return (
    <div className="page">
      <header>
        <h2>{overview.workspace.name}</h2>
        <p className="lede">
          The owner&apos;s view: spend, runs, people and limits. Everything else has its own page.
        </p>
      </header>

      <div className="stats">
        <div className="stat">
          <span className="stat-label">Spent today</span>
          <span className={`stat-value${capUsed >= 1 ? ' danger' : ''}`}>{usd(spend.todayUsd)}</span>
          <span className="faint">of a {usd(spend.dailyCapUsd)} daily cap</span>
          <span className="meter" aria-hidden><span style={{ width: `${Math.min(100, capUsed * 100)}%` }} className={capUsed >= 0.8 ? 'warn' : ''} /></span>
        </div>
        <div className="stat">
          <span className="stat-label">Last {runs.windowDays} days</span>
          <span className="stat-value">{runs.total} runs</span>
          <span className="faint">{usd(spend.windowUsd)} · {succeeded} done · {failed} failed</span>
        </div>
        <Link href={`/w/${workspaceId}/approvals`} className="stat link">
          <span className="stat-label">Waiting on you</span>
          <span className={`stat-value${counts.pendingApprovals > 0 ? ' warn' : ''}`}>{counts.pendingApprovals}</span>
          <span className="faint">{counts.pendingApprovals === 1 ? 'approval' : 'approvals'}{waiting > 0 ? ` · ${waiting} runs paused` : ''}</span>
        </Link>
        <div className="stat">
          <span className="stat-label">In the workspace</span>
          <span className="stat-value">{counts.assistants} {counts.assistants === 1 ? 'assistant' : 'assistants'}</span>
          <span className="faint">{counts.members} {counts.members === 1 ? 'person' : 'people'} · {counts.providers} {counts.providers === 1 ? 'provider' : 'providers'} · {counts.channels} {counts.channels === 1 ? 'channel' : 'channels'}</span>
        </div>
      </div>

      <div className="two-up">
        <section className="card">
          <p className="eyebrow" style={{ marginTop: 0 }}>Spend by day</p>
          <SpendChart days={spend.byDay} />
        </section>
        <section className="card">
          <p className="eyebrow" style={{ marginTop: 0 }}>Spend by model, last 30 days</p>
          {spend.byModel.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nothing has run yet.</p>
          ) : (
            <table className="tight">
              <tbody>
                {spend.byModel.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td className="muted">{m.runs} runs</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{usd(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <p className="eyebrow" style={{ marginTop: 0 }}>Assistants, last {runs.windowDays} days</p>
        {runs.byAgent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No runs in this window.</p>
        ) : (
          <table className="tight">
            <thead><tr><th>Assistant</th><th>Runs</th><th>Failed</th><th style={{ textAlign: 'right' }}>Spend</th></tr></thead>
            <tbody>
              {runs.byAgent.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/w/${workspaceId}/agents/${a.id}`}>{a.name}</Link></td>
                  <td>{a.runs}</td>
                  <td className={a.failed > 0 ? 'danger' : 'muted'}>{a.failed}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{usd(a.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <People workspaceId={workspaceId} onChange={reload} />

      {overview.workspace.settings !== undefined && (
        <Limits workspaceId={workspaceId} initial={overview.workspace.settings} name={overview.workspace.name} onSaved={reload} />
      )}

      <section className="card">
        <p className="eyebrow" style={{ marginTop: 0 }}>Recent admin activity</p>
        {overview.audit.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nothing recorded yet. Role changes, invitations and removals appear here.</p>
        ) : (
          <ul className="audit">
            {overview.audit.map((entry) => (
              <li key={entry.id}>
                <span className="badge">{entry.action}</span>
                <span className="muted">{entry.subject.type}{entry.subject.id ? ` ${entry.subject.id}` : ''}</span>
                <span className="faint" style={{ marginLeft: 'auto' }}>{ago(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- chart -- */

/**
 * Fourteen bars. CSS heights rather than a chart library: there is one
 * series, and the number on hover is the whole legend.
 */
function SpendChart({ days }: { days: { day: string; costUsd: number }[] }) {
  const max = Math.max(0.01, ...days.map((d) => d.costUsd));
  return (
    <div className="bars" role="img" aria-label={`Spend per day for the last ${days.length} days`}>
      {days.map((d) => (
        <div key={d.day} className="bar" title={`${d.day}: ${usd(d.costUsd)}`}>
          <span style={{ height: `${Math.max(2, (d.costUsd / max) * 100)}%` }} className={d.costUsd === 0 ? 'zero' : ''} />
          <small>{d.day.slice(8)}</small>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- people -- */

function People({ workspaceId, onChange }: { workspaceId: string; onChange: () => void }) {
  const dialog = useDialog();
  const [members, setMembers] = useState<Member[]>();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ email: string; link: string }>();
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api.get<{ items: Member[]; invitations: Invitation[] }>(`${ws(workspaceId)}/members`)
      .then((r) => { setMembers(r.items); setInvitations(r.invitations); })
      .catch((e: Error) => setError(e.message));
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  const me = members?.find((m) => m.you);
  const canOwn = me?.role === 'owner';

  return (
    <section className="card">
      <p className="eyebrow" style={{ marginTop: 0 }}>People</p>
      {error !== undefined && <p className="error">{error}</p>}

      <div className="scroll-x">
      <table className="tight">
        <thead><tr><th>Who</th><th>Role</th><th>Since</th><th /></tr></thead>
        <tbody>
          {(members ?? []).map((m) => (
            <tr key={m.userId}>
              <td>
                <strong>{m.name ?? m.email ?? m.userId}</strong>{m.you && <span className="badge" style={{ marginLeft: 6 }}>you</span>}
                {m.name !== undefined && m.email !== undefined && <span className="muted" style={{ display: 'block', fontSize: 12 }}>{m.email}</span>}
              </td>
              <td>
                <select
                  value={m.role}
                  aria-label={`Role of ${m.name ?? m.email ?? 'member'}`}
                  disabled={busy || (m.role === 'owner' && !canOwn)}
                  title={ROLE_HELP[m.role]}
                  onChange={async (e) => {
                    const next = e.target.value as Role;
                    setBusy(true);
                    try {
                      await api.patch(`${ws(workspaceId)}/members/${m.userId}`, { role: next });
                      reload(); onChange();
                    } catch (caught) {
                      await dialog.notice({ title: 'Could not change that role', body: caught instanceof Error ? caught.message : undefined });
                    } finally { setBusy(false); }
                  }}
                >
                  {(['owner', 'admin', 'member', 'viewer'] as const).map((r) => (
                    <option key={r} value={r} disabled={r === 'owner' && !canOwn}>{r}</option>
                  ))}
                </select>
              </td>
              <td className="muted">{ago(m.joinedAt)}</td>
              <td style={{ textAlign: 'right' }}>
                {!m.you && (
                  <button
                    type="button" className="ghost danger" disabled={busy || (m.role === 'owner' && !canOwn)}
                    onClick={async () => {
                      const yes = await dialog.confirm({ title: `Remove ${m.name ?? m.email ?? 'this person'}?`, body: 'They lose access at once. What they did stays in Activity.', confirmLabel: 'Remove', danger: true });
                      if (!yes) return;
                      setBusy(true);
                      try {
                        await api.del(`${ws(workspaceId)}/members/${m.userId}`);
                        reload(); onChange();
                      } catch (caught) {
                        await dialog.notice({ title: 'Could not remove them', body: caught instanceof Error ? caught.message : undefined });
                      } finally { setBusy(false); }
                    }}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
          {invitations.map((i) => (
            <tr key={i.id} className="muted">
              <td>{i.email}<span className="badge" style={{ marginLeft: 6 }}>invited</span></td>
              <td>{i.role}</td>
              <td>expires in {daysUntil(i.expiresAt)}</td>
              <td style={{ textAlign: 'right' }}>
                <button
                  type="button" className="ghost" disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try { await api.del(`${ws(workspaceId)}/invitations/${i.id}`); reload(); onChange(); } catch (caught) {
                      await dialog.notice({ title: 'Could not withdraw that', body: caught instanceof Error ? caught.message : undefined });
                    } finally { setBusy(false); }
                  }}
                >
                  Withdraw
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <form
        className="invite"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true); setLink(undefined);
          try {
            const made = await api.post<{ email: string; link: string }>(`${ws(workspaceId)}/invitations`, { email, role });
            setLink(made); setEmail(''); reload(); onChange();
          } catch (caught) {
            await dialog.notice({ title: 'Could not invite them', body: caught instanceof Error ? caught.message : undefined });
          } finally { setBusy(false); }
        }}
      >
        <label htmlFor="invite-email" className="sr-only">Email</label>
        <input id="invite-email" type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select value={role} aria-label="Role" onChange={(e) => setRole(e.target.value as Role)} title={ROLE_HELP[role]}>
          <option value="admin">admin</option>
          <option value="member">member</option>
          <option value="viewer">viewer</option>
        </select>
        <button type="submit" className="primary" disabled={busy || email.trim() === ''}><Icon name="plus" size={14} /> Invite</button>
      </form>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
        {ROLE_HELP[role]} You get a link to send them yourself; it works only for that address, for a week.
      </p>
      {link !== undefined && (
        <div className="note" style={{ marginTop: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <strong>Send this to {link.email}.</strong> It is shown once.
            <Copyable value={link.link} />
          </div>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- limits -- */

function Limits({
  workspaceId, initial, name, onSaved,
}: {
  workspaceId: string; initial: Settings; name: string; onSaved: () => void;
}) {
  const dialog = useDialog();
  const [title, setTitle] = useState(name);
  const [cap, setCap] = useState(String(initial.dailyCostCapUsd));
  const [concurrent, setConcurrent] = useState(String(initial.maxConcurrentRuns));
  const [effect, setEffect] = useState(initial.defaultToolEffect);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <section className="card">
      <p className="eyebrow" style={{ marginTop: 0 }}>Limits and defaults</p>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true); setSaved(false);
          try {
            await api.patch(ws(workspaceId), {
              name: title.trim(),
              dailyCostCapUsd: Number(cap),
              maxConcurrentRuns: Number(concurrent),
              defaultToolEffect: effect,
            });
            setSaved(true); onSaved();
          } catch (caught) {
            await dialog.notice({ title: 'Could not save', body: caught instanceof Error ? caught.message : undefined });
          } finally { setBusy(false); }
        }}
      >
        <div className="two-up">
          <div>
            <label htmlFor="ws-name">Workspace name</label>
            <input id="ws-name" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label htmlFor="ws-cap">Daily spend cap, USD</label>
            <input id="ws-cap" type="number" min={0} step="0.5" value={cap} onChange={(e) => setCap(e.target.value)} />
            <p className="faint" style={{ margin: '4px 0 0' }}>Runs stop for the day when this is reached.</p>
          </div>
          <div>
            <label htmlFor="ws-conc">Runs at once</label>
            <input id="ws-conc" type="number" min={1} max={64} value={concurrent} onChange={(e) => setConcurrent(e.target.value)} />
          </div>
          <div>
            <label htmlFor="ws-effect">Tools that change things, by default</label>
            <select id="ws-effect" value={effect} onChange={(e) => setEffect(e.target.value as Settings['defaultToolEffect'])}>
              <option value="ask">Ask me first</option>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>
          </div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <button type="submit" className="primary" disabled={busy || title.trim() === ''}>{busy ? 'Saving…' : 'Save'}</button>
          {saved && <span className="muted">Saved.</span>}
        </div>
      </form>
    </section>
  );
}
