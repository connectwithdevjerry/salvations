'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CHANNELS, type CatalogEntry } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { AppLogo } from '@/components/app-logo';

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

/**
 * The phone, showing the assistant where the hovered or chosen way puts it.
 *
 * Each way is drawn the way that app looks: Telegram's bubbles, Discord's
 * and Slack's rows under a channel name, HIVE's own chat, and the voice
 * console for out loud. The words are the same so the eye compares the
 * place, not the conversation.
 */
export function PhoneMock({ agentName, way }: { agentName: string; way: TalkWay }) {
  const ask = 'Chase Northgate about invoice 2214';
  const reply = 'Done. I sent them a firm reminder, and they’ve replied: paying Friday.';
  const rows = (channel: string) => (
    <>
      <div className="phone-channel"># {channel}</div>
      <div className="phone-row">
        <span className="phone-row-avatar you" />
        <span><b>You</b> <small>9:41</small><br />{ask}</span>
      </div>
      <div className="phone-row">
        <span className="phone-row-avatar" style={{ background: way.accent }} />
        <span><b>{agentName}</b> <small>9:41</small><br />{reply}</span>
      </div>
    </>
  );

  return (
    <div className={`phone ${way.id}`} aria-hidden>
      <div className="phone-top"><span>9:41</span><span className="phone-notch" /><span>●●●</span></div>
      {way.id === 'voice' ? (
        <div className="phone-body voice">
          <div className="phone-orb"><span /></div>
          <small className="phone-live">LISTENING</small>
          <div className="phone-transcript">
            <span>you</span><p>{ask}</p>
            <span>{agentName.toLowerCase()}</span><p>{reply}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="phone-head">
            <span className="phone-avatar" style={{ background: way.accent }} />
            <strong>{agentName}</strong>
            <small style={{ color: way.accent }}>on {way.id === 'web' ? 'HIVE' : way.name}</small>
          </div>
          <div className="phone-body">
            {way.id === 'discord' || way.id === 'slack' ? rows('general') : (
              <>
                <small>Today 9:41</small>
                <p className="you">{ask}</p>
                {way.id === 'telegram' && <small className="end">Delivered</small>}
                <p>{reply}</p>
              </>
            )}
          </div>
        </>
      )}
      <div className="phone-input">
        {way.id === 'voice' ? <span className="phone-stop">■ STOP</span>
          : way.id === 'discord' || way.id === 'slack' ? 'Message #general'
            : way.id === 'web' ? `Message ${agentName}` : 'Message'}
      </div>
    </div>
  );
}

export function WayCards({
  ways, selected, statusOf, onPick, onHover,
}: {
  ways: readonly TalkWay[];
  selected?: string | undefined;
  statusOf: (way: TalkWay) => string | undefined;
  onPick: (way: TalkWay) => void;
  /** The way under the pointer, or undefined when it leaves: the phone follows it. */
  onHover?: (way: TalkWay | undefined) => void;
}) {
  return (
    <div className="ways" onMouseLeave={() => onHover?.(undefined)}>
      {ways.map((way) => {
        const status = statusOf(way);
        return (
          <button
            key={way.id} type="button"
            className={selected === way.id ? 'way on' : 'way'}
            onClick={() => onPick(way)}
            onMouseEnter={() => onHover?.(way)}
            onFocus={() => onHover?.(way)}
          >
            {way.entry !== undefined
              ? <AppLogo id={way.entry.id} name={way.entry.name} accent={way.accent} size={44} />
              : (
                <span className="way-tile" style={{ ['--accent-brand' as string]: way.accent }} aria-hidden>
                  <Icon name={way.id === 'voice' ? 'mic' : 'chat'} size={20} />
                </span>
              )}
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
  const [hovered, setHovered] = useState<TalkWay>();

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
        <PhoneMock agentName={agentName} way={picked ?? hovered ?? WAYS[0]!} />
        <div className="ways-main">
          <button type="button" className="ghost ways-close" aria-label="Close" onClick={onClose}><Icon name="exit" size={16} /></button>
          {picked?.entry === undefined ? (
            <>
              <h3 id="ways-title">Text {agentName} like a teammate.</h3>
              <p className="muted">{agentName} answers wherever you already are. Pick one now; add the rest any time.</p>
              <WayCards ways={WAYS} statusOf={statusOf} onHover={setHovered} onPick={(way) => { if (way.entry !== undefined) setPicked(way); }} />
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
