'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CHANNELS, type CatalogEntry } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';

/**
 * Where you can reach an assistant.
 *
 * A phone on the left showing the kind of exchange that happens there, and
 * the ways on the right: the chat platforms it can be connected to, plus
 * the two that are always on, here in the browser and out loud. Picking a
 * platform opens its setup where this is shown.
 */

export interface TalkWay {
  readonly id: string;
  readonly name: string;
  readonly sub: string;
  readonly accent: string;
  readonly entry?: CatalogEntry;
  readonly always?: true;
}

const SUB: Record<string, string> = { telegram: 'From your phone', discord: 'In your server', slack: 'In your workspace' };

export const WAYS: readonly TalkWay[] = [
  ...CHANNELS.map((entry) => ({ id: entry.id, name: entry.name, sub: SUB[entry.id] ?? entry.summary, accent: entry.accent, entry })),
  { id: 'web', name: 'Here', sub: 'In the browser', accent: '#3b82f6', always: true },
  { id: 'voice', name: 'Out loud', sub: 'By voice, on Speak', accent: '#F59E0B', always: true },
];

export function PhoneMock({ agentName, way }: { agentName: string; way: TalkWay }) {
  return (
    <div className="phone" aria-hidden>
      <div className="phone-top"><span>9:41</span><span className="phone-notch" /><span>●●●</span></div>
      <div className="phone-head">
        <span className="phone-avatar" style={{ background: way.accent }} />
        <strong>{agentName}</strong>
        <small style={{ color: way.accent }}>on {way.name === 'Here' ? 'HIVE' : way.name}</small>
      </div>
      <div className="phone-body">
        <small>Today 9:41</small>
        <p className="you">Chase Northgate about invoice 2214</p>
        <small className="end">Delivered</small>
        <p>Done. I sent them a firm reminder, and they&apos;ve replied: paying Friday.</p>
      </div>
      <div className="phone-input">{way.name === 'Out loud' ? '🎙 Speak' : 'Message'}</div>
    </div>
  );
}

export function WayCards({
  ways, selected, statusOf, onPick,
}: {
  ways: readonly TalkWay[];
  selected?: string | undefined;
  statusOf: (way: TalkWay) => string | undefined;
  onPick: (way: TalkWay) => void;
}) {
  return (
    <div className="ways">
      {ways.map((way) => {
        const status = statusOf(way);
        return (
          <button
            key={way.id} type="button"
            className={selected === way.id ? 'way on' : 'way'}
            onClick={() => onPick(way)}
          >
            <span className="way-tile" style={{ ['--accent-brand' as string]: way.accent }} aria-hidden>
              <Icon name={way.id === 'voice' ? 'mic' : 'chat'} size={20} />
            </span>
            <span className="way-copy">
              <strong>{way.name}</strong>
              <small>{way.sub}</small>
            </span>
            {status !== undefined && <span className={`badge ${status === 'Connected' || status === 'Always on' ? 'ok' : 'warn'}`}>{status}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The dialog opened from an assistant's header. */
export function WaysToTalkDialog({
  workspaceId, agentId, agentName, onClose, renderSetup,
}: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  onClose: () => void;
  /** The setup panel for a platform, supplied by whoever owns the channel forms. */
  renderSetup: (entry: CatalogEntry, reload: () => void) => ReactNode;
}) {
  const [channels, setChannels] = useState<{ channel: string; status: string; agentId: string }[]>([]);
  const [picked, setPicked] = useState<TalkWay>();

  const reload = useCallback(() => {
    void api.get<{ items: { channel: string; status: string; agentId: string }[] }>(`${ws(workspaceId)}/channels`)
      .then((r) => setChannels(r.items.filter((c) => c.agentId === agentId))).catch(() => undefined);
  }, [workspaceId, agentId]);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const statusOf = (way: TalkWay) => {
    if (way.always === true) return 'Always on';
    const c = channels.find((x) => x.channel === way.id);
    return c === undefined ? undefined : c.status === 'connected' ? 'Connected' : 'Needs setup';
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog ways-dialog" role="dialog" aria-modal="true" aria-labelledby="ways-title">
        <PhoneMock agentName={agentName} way={picked ?? WAYS[0]!} />
        <div className="ways-main">
          <button type="button" className="ghost ways-close" aria-label="Close" onClick={onClose}><Icon name="exit" size={16} /></button>
          {picked?.entry === undefined ? (
            <>
              <h3 id="ways-title">Text {agentName} like a teammate.</h3>
              <p className="muted">{agentName} answers wherever you already are. Pick one now; add the rest any time.</p>
              <WayCards ways={WAYS} statusOf={statusOf} onPick={(way) => { if (way.entry !== undefined) setPicked(way); }} />
            </>
          ) : (
            <>
              <button type="button" className="link" onClick={() => setPicked(undefined)}>← All the ways</button>
              <h3 id="ways-title" style={{ marginTop: 8 }}>{picked.name}</h3>
              <div style={{ marginTop: 10 }}>{renderSetup(picked.entry, reload)}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
