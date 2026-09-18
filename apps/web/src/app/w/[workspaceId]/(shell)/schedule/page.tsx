'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ws } from '@/lib/client/api';
import { Icon, Option, Tile } from '@/components/ui';

/**
 * Schedule.
 *
 * Cron is offered as presets with the expression visible underneath, rather
 * than hidden behind them. The presets cover what people actually want; the
 * expression is there because somebody eventually wants "every second Tuesday"
 * and hiding it would mean they simply cannot have it.
 */

interface Schedule {
  id: string; name: string; expression: string; timeZone: string;
  agentId: string; prompt: string; enabled: boolean;
  lastFiredFor?: string; lastRunId?: string;
  consecutiveFailures: number; lastError?: string; nextRunAt?: string;
}
interface Agent { id: string; name: string }
interface ModelBinding { id: string; name: string }

const PRESETS = [
  { label: 'Every hour', expression: '0 * * * *' },
  { label: 'Every morning at 9', expression: '0 9 * * *' },
  { label: 'Weekday mornings at 9', expression: '0 9 * * 1-5' },
  { label: 'Monday mornings at 9', expression: '0 9 * * 1' },
  { label: 'First of the month', expression: '0 9 1 * *' },
] as const;

export default function SchedulePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(params);
  const [schedules, setSchedules] = useState<Schedule[]>();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<ModelBinding[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api.get<{ items: Schedule[] }>(`${ws(workspaceId)}/schedules`)
      .then((r) => setSchedules(r.items))
      .catch((e: Error) => { setError(e.message); setSchedules([]); });
  }, [workspaceId]);

  useEffect(() => {
    reload();
    void api.get<{ items: Agent[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => setAgents(r.items)).catch(() => undefined);
    void api.get<{ items: ModelBinding[] }>(`${ws(workspaceId)}/models`)
      .then((r) => setModels(r.items)).catch(() => undefined);
  }, [reload, workspaceId]);

  return (
    <div className="page">
      <header>
        <h2>Schedule</h2>
        <p className="lede">
          Give an agent something to do on its own. Each run starts a fresh conversation, so a
          daily job does not drag yesterday's context along behind it.
        </p>
      </header>

      {error !== undefined && <p className="error">{error}</p>}

      {agents.length === 0 || models.length === 0 ? (
        <div className="note">
          <span className="tile" aria-hidden><Icon name="agent" size={16} /></span>
          <span>
            A schedule needs an agent and a model.
            {agents.length === 0 && ' Create an agent first.'}
            {models.length === 0 && ' Connect a model provider first.'}
          </span>
        </div>
      ) : (
        <Option
          icon="gear"
          title="New schedule"
          subtitle="Pick when, and say what to do."
          open={creating}
          onToggle={() => setCreating(!creating)}
        >
          <ScheduleForm
            workspaceId={workspaceId}
            agents={agents}
            models={models}
            onDone={() => { setCreating(false); reload(); }}
            onError={setError}
          />
        </Option>
      )}

      {schedules !== undefined && schedules.length > 0 && (
        <>
          <p className="eyebrow" style={{ marginTop: 26 }}>Scheduled</p>
          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              workspaceId={workspaceId}
              schedule={schedule}
              onChanged={reload}
              onError={setError}
            />
          ))}
        </>
      )}

      {schedules?.length === 0 && (
        <p className="muted" style={{ marginTop: 20 }}>
          Nothing scheduled yet.
        </p>
      )}
    </div>
  );
}

function ScheduleRow({
  workspaceId, schedule, onChanged, onError,
}: {
  workspaceId: string;
  schedule: Schedule;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const base = `${ws(workspaceId)}/schedules/${schedule.id}`;

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
          <Tile name="gear" />
          <div style={{ minWidth: 0 }}>
            <strong>{schedule.name}</strong>
            {!schedule.enabled && <span className="badge" style={{ marginLeft: 8 }}>paused</span>}
            {schedule.consecutiveFailures > 0 && (
              <span className="badge danger" style={{ marginLeft: 8 }}>
                {schedule.consecutiveFailures} failed
              </span>
            )}
            <p className="muted" style={{ margin: '3px 0 0' }}>
              <span className="mono">{schedule.expression}</span> · {schedule.timeZone}
            </p>
            <p className="muted" style={{ margin: '4px 0 0', maxWidth: 520 }}>{schedule.prompt}</p>
            {schedule.lastError !== undefined && (
              <p className="muted" style={{ margin: '4px 0 0', color: 'var(--danger)' }}>
                {schedule.lastError}
              </p>
            )}
          </div>
        </div>

        <div style={{ textAlign: 'right', flex: 'none' }}>
          <p className="faint" style={{ margin: 0 }}>
            {schedule.enabled && schedule.nextRunAt !== undefined
              ? `next ${new Date(schedule.nextRunAt).toLocaleString()}`
              : schedule.enabled ? 'no upcoming run' : 'paused'}
          </p>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
            {schedule.lastRunId !== undefined && (
              <Link href={`/w/${workspaceId}/runs/${schedule.lastRunId}`}>
                <button type="button">Last run</button>
              </Link>
            )}
            <button
              type="button" disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.patch(base, { enabled: !schedule.enabled });
                  onChanged();
                } catch (caught) {
                  onError(caught instanceof Error ? caught.message : 'Could not change that.');
                } finally { setBusy(false); }
              }}
            >
              {schedule.enabled ? 'Pause' : 'Resume'}
            </button>
            <button
              type="button" className="danger" disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.del(base);
                  onChanged();
                } catch (caught) {
                  onError(caught instanceof Error ? caught.message : 'Could not delete that.');
                } finally { setBusy(false); }
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScheduleForm({
  workspaceId, agents, models, onDone, onError,
}: {
  workspaceId: string;
  agents: Agent[];
  models: ModelBinding[];
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [expression, setExpression] = useState<string>(PRESETS[1].expression);
  // The browser knows where the person is; asking would be asking a question we
  // can already answer.
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [modelBindingId, setModelBindingId] = useState(models[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api.post(`${ws(workspaceId)}/schedules`, {
            name, expression, timeZone, agentId, modelBindingId, prompt,
          });
          onDone();
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : 'Could not create that schedule.');
        } finally { setBusy(false); }
      }}
    >
      <div>
        <label htmlFor="scheduleName">Name</label>
        <input
          id="scheduleName" required placeholder="Morning briefing"
          value={name} onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div>
        <label>When</label>
        <div className="tabs">
          {PRESETS.map((preset) => (
            <button
              key={preset.expression}
              type="button"
              className={expression === preset.expression ? 'tab on' : 'tab'}
              onClick={() => setExpression(preset.expression)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <input
          aria-label="Cron expression"
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
          className="mono"
          style={{ marginTop: 8 }}
        />
        <p className="muted" style={{ margin: '5px 0 0' }}>
          Five fields: minute hour day month weekday. The presets write this for you; edit it
          when you want something they do not cover.
        </p>
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="timeZone">Time zone</label>
          <input id="timeZone" required value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="scheduleAgent">Agent</label>
          <select id="scheduleAgent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="scheduleModel">Model</label>
          <select
            id="scheduleModel" value={modelBindingId}
            onChange={(e) => setModelBindingId(e.target.value)}
          >
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="schedulePrompt">What to do</label>
        <textarea
          id="schedulePrompt" required
          placeholder="Summarise anything that arrived overnight and flag what needs me."
          value={prompt} onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create schedule'}
      </button>
    </form>
  );
}
