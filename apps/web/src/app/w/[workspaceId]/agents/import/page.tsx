'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ws } from '@/lib/client/api';
import { BrandMark, Icon, Tile } from '@/components/ui';

/**
 * Bringing an assistant from elsewhere here.
 *
 * Zip the workspace folder, drop it here, read what would be made, say
 * yes. Nothing is written until the second step, and the plan shown is the
 * plan that runs.
 */
interface Plan {
  name: string;
  emoji?: string;
  root: string;
  promptChars: number;
  memories: number;
  documents: string[];
  heartbeat: boolean;
  skipped: { path: string; reason: string }[];
}

interface Made {
  id: string;
  name: string;
  made: { memories: number; documents: number; routine?: string };
  problems: string[];
}

export default function ImportPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const router = useRouter();
  const [file, setFile] = useState<File>();
  const [plan, setPlan] = useState<Plan>();
  const [made, setMade] = useState<Made>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function send(commit: boolean) {
    if (file === undefined) return;
    setBusy(true); setError(undefined);
    const form = new FormData();
    form.set('archive', file);
    form.set('commit', commit ? 'true' : 'false');
    try {
      const result = await api.upload<{ plan: Plan } & Partial<Made>>(`${ws(workspaceId)}/agents/import/workspace`, form);
      if (commit && result.id !== undefined) setMade(result as Made);
      else setPlan(result.plan);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That archive could not be read.');
    } finally { setBusy(false); }
  }

  return (
    <div className="wizard">
      <div className="wizard-bar">
        <BrandMark wordmark={false} />
        <span />
        <button className="ghost" type="button" aria-label="Back to the workspace" onClick={() => router.push(`/w/${workspaceId}/agents`)}>
          <Icon name="exit" size={17} />
        </button>
      </div>
      <div className="wizard-body">
        <div className="wizard-head">
          <Tile name="agent" large />
          <div>
            <h2>Bring an assistant you already have</h2>
            <p>
              Zip your assistant&apos;s workspace folder, the one with SOUL.md and AGENTS.md in it, and drop
              it here. Its persona and rules become the assistant&apos;s instructions, its memory becomes
              memories, and its notes and skills become documents it can search.
            </p>
          </div>
        </div>
        {error !== undefined && <p className="error">{error}</p>}

        {made !== undefined ? (
          <div className="card">
            <strong>{made.name} is here.</strong>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              {made.made.memories} {made.made.memories === 1 ? 'memory' : 'memories'}, {made.made.documents}{' '}
              {made.made.documents === 1 ? 'document' : 'documents'}{made.made.routine !== undefined ? ', and a daily routine from the heartbeat' : ''}.
            </p>
            {made.problems.length > 0 && (
              <ul className="muted" style={{ margin: '10px 0 0', paddingLeft: 18 }}>
                {made.problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}
            <p style={{ margin: '16px 0 0' }}>
              <button className="primary lg" type="button" onClick={() => router.push(`/w/${workspaceId}/agents/${made.id}`)}>
                Open {made.name} <Icon name="arrow" size={15} />
              </button>
            </p>
            <p className="muted" style={{ margin: '12px 0 0', fontSize: 13 }}>
              Next: connect its Telegram bot on the Integrations tab, and choose its model. Channel tokens and scheduled jobs live in the gateway&apos;s configuration rather than the workspace, so set those up here.
            </p>
          </div>
        ) : (
          <>
            <div className="card">
              <label htmlFor="archive">Workspace archive (.zip)</label>
              <input
                id="archive" type="file" accept=".zip,application/zip"
                onChange={(e) => { setFile(e.target.files?.[0]); setPlan(undefined); }}
              />
              <p style={{ margin: '14px 0 0' }}>
                <button className="primary" type="button" disabled={busy || file === undefined} onClick={() => void send(false)}>
                  {busy && plan === undefined ? 'Reading…' : 'Read the archive'}
                </button>
              </p>
            </div>

            {plan !== undefined && (
              <div className="card" style={{ marginTop: 14 }}>
                <strong>What will be made</strong>
                <dl className="facts" style={{ marginTop: 10 }}>
                  <div><dt>Assistant</dt><dd>{plan.emoji !== undefined ? `${plan.emoji} ` : ''}{plan.name}</dd></div>
                  <div><dt>Found in</dt><dd className="mono">{plan.root}</dd></div>
                  <div><dt>Instructions</dt><dd>{plan.promptChars.toLocaleString()} characters from SOUL.md, AGENTS.md and USER.md</dd></div>
                  <div><dt>Memories</dt><dd>{plan.memories} from MEMORY.md</dd></div>
                  <div><dt>Documents</dt><dd>{plan.documents.length === 0 ? 'none' : plan.documents.join(', ')}</dd></div>
                  <div><dt>Routine</dt><dd>{plan.heartbeat ? 'a daily one from HEARTBEAT.md, if a chat model is connected' : 'none'}</dd></div>
                </dl>
                {plan.skipped.length > 0 && (
                  <>
                    <p className="eyebrow" style={{ marginTop: 14 }}>Left out</p>
                    <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                      {plan.skipped.map((s) => <li key={s.path}><span className="mono">{s.path}</span>: {s.reason}</li>)}
                    </ul>
                  </>
                )}
                <p style={{ margin: '16px 0 0' }}>
                  <button className="primary lg" type="button" disabled={busy} onClick={() => void send(true)}>
                    {busy ? 'Importing…' : `Create ${plan.name}`}
                  </button>
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
