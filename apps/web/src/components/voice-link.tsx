'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { useSpeak, type Phase } from '@/lib/client/use-speak';

/**
 * Voice link: speaking to an assistant, as a screen rather than a form.
 *
 * A dark instrument panel around one circle. Everything on it is real: the
 * clock is the session's, the level is the microphone's, the latency is the
 * last reply's, the log is what happened. Where a real panel would show a
 * reading we do not have, this one shows nothing. The transcript sits
 * behind a toggle so the circle is the room, not the text.
 */

const STATE: Record<Phase, string> = {
  idle: 'STANDBY', listening: 'LISTENING', hearing: 'HEARING', answering: 'THINKING', speaking: 'SPEAKING',
};

export function VoiceLink({ workspaceId, agentId, agentName }: { workspaceId: string; agentId: string; agentName: string }) {
  const speak = useSpeak(workspaceId, agentId);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  const [showText, setShowText] = useState(false);
  const [model, setModel] = useState<string>();
  const shell = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void api.get<{ current?: { displayName?: string } }>(`${ws(workspaceId)}/agents/${agentId}/model`)
      .then((r) => setModel(r.current?.displayName)).catch(() => undefined);
  }, [workspaceId, agentId]);

  // Escape leaves full screen; the browser handles the rest.
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === shell.current && shell.current !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const elapsed = now - startedAt;
  const last = speak.exchanges[speak.exchanges.length - 1];
  const latency = last?.repliedAt === undefined ? undefined : last.repliedAt - last.sentAt;
  const heardWords = speak.exchanges.reduce((n, e) => n + e.said.split(/\s+/).filter(Boolean).length, 0);
  const spokenWords = speak.exchanges.reduce((n, e) => n + e.answer.split(/\s+/).filter(Boolean).length, 0);
  const secure = typeof window !== 'undefined' && window.isSecureContext;
  const busy = speak.phase === 'hearing' || speak.phase === 'answering';

  if (!speak.canRecord) {
    return (
      <div className="page">
        <div className="note">
          <span className="tile" aria-hidden><Icon name="shield" size={16} /></span>
          <span>This browser cannot record audio here. Recording needs a secure (https) page and a browser with microphone support.</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={shell} className={`vl${full ? ' full' : ''}`}>
      <div className="vl-grid" aria-hidden />

      <header className="vl-top">
        <div>
          <p className="vl-title"><span className="vl-hex" aria-hidden /> {agentName.toUpperCase()} <span className="vl-dim">// VOICE LINK</span></p>
          <p className="vl-sub">SPEAK · THIS CONVERSATION, OUT LOUD</p>
          <div className="vl-pills">
            <span className="vl-pill on">● ONLINE</span>
            <span className={`vl-pill${secure ? ' on' : ''}`}>● {secure ? 'SECURE' : 'INSECURE'}</span>
            <span className={`vl-pill${speak.phase !== 'idle' ? ' on' : ''}`}>● {STATE[speak.phase]}</span>
          </div>
        </div>
        <div className="vl-right">
          <p className="vl-clock">{clock(elapsed)}</p>
          <button type="button" className="vl-exit" onClick={() => {
            if (document.fullscreenElement !== null) void document.exitFullscreen();
            else void shell.current?.requestFullscreen().catch(() => undefined);
          }}>
            {full ? '× EXIT' : '⤢ FULL SCREEN'} <kbd>{full ? 'ESC' : 'F'}</kbd>
          </button>
          <dl className="vl-facts">
            <div><dt>DATE</dt><dd>{new Date(now).toISOString().slice(0, 10)}</dd></div>
            <div><dt>SESSION</dt><dd>{speak.conversationId === undefined ? '—' : speak.conversationId.slice(-8).toUpperCase()}</dd></div>
            <div><dt>MODEL</dt><dd>{model ?? '—'}</dd></div>
            <div><dt>TURNS</dt><dd>{speak.exchanges.length}</dd></div>
            <div><dt>LAST REPLY</dt><dd>{latency === undefined ? '—' : `${(latency / 1000).toFixed(1)}S`}</dd></div>
          </dl>
        </div>
      </header>

      <aside className="vl-left">
        <p className="vl-eyebrow">│ VITALS</p>
        <Vital label="INPUT LEVEL" value={`${Math.round(speak.level * 100)}%`} ratio={speak.level} />
        <Vital label="REPLY LATENCY" value={latency === undefined ? '—' : `${(latency / 1000).toFixed(1)}s`} ratio={latency === undefined ? 0 : Math.min(1, latency / 20_000)} />
        <Vital label="TURNS" value={String(speak.exchanges.length)} ratio={Math.min(1, speak.exchanges.length / 20)} />
        <Vital label="WORDS HEARD" value={String(heardWords)} ratio={Math.min(1, heardWords / 500)} />
        <Vital label="WORDS SPOKEN" value={String(spokenWords)} ratio={Math.min(1, spokenWords / 500)} />
        <Vital label="SAMPLE RATE" value={speak.sampleRate === undefined ? '—' : `${(speak.sampleRate / 1000).toFixed(1)}kHz`} ratio={speak.sampleRate === undefined ? 0 : 0.6} />

        <p className="vl-eyebrow" style={{ marginTop: 22 }}>│ LOG</p>
        <ul className="vl-log">
          {speak.log.length === 0 && <li className="info"><span>—</span>waiting for the first word</li>}
          {speak.log.slice(-14).map((line, i) => (
            <li key={`${line.at}-${i}`} className={line.kind}>
              <span>{new Date(line.at).toTimeString().slice(0, 8)}</span>
              <em>{line.kind === 'err' ? 'ERR' : line.kind === 'info' ? 'INF' : 'OK'}</em>
              {line.text}
            </li>
          ))}
        </ul>
      </aside>

      <main className="vl-centre">
        <Orb phase={speak.phase} level={speak.level} analyser={speak.analyser} />
      </main>

      <aside className="vl-rightcol">
        <p className="vl-eyebrow">AUDIO I/O │</p>
        <Spectrum analyser={speak.analyser} active={speak.phase === 'listening'} />
        <p className="vl-small">{speak.sampleRate === undefined ? '—' : `${(speak.sampleRate / 1000).toFixed(0)}kHz`} · {speak.phase === 'listening' ? 'RX' : speak.phase === 'speaking' ? 'TX' : 'IDLE'}</p>

        <p className="vl-eyebrow" style={{ marginTop: 22 }}>TOOLS │</p>
        <ul className="vl-log right">
          {speak.toolCalls.length === 0 && <li className="info">none this turn</li>}
          {speak.toolCalls.map((call) => (
            <li key={call.id} className={call.isError === true ? 'err' : call.finished ? 'ok' : 'info'}>
              <em>{call.isError === true ? 'ERR' : call.finished ? 'OK' : '…'}</em>{call.name}
            </li>
          ))}
        </ul>
      </aside>

      {showText && (
        <section className="vl-text">
          <div className="vl-text-head">
            <strong>Transcript</strong>
            <button type="button" className="ghost" onClick={() => setShowText(false)} aria-label="Hide transcript"><Icon name="exit" size={14} /></button>
          </div>
          <div className="vl-text-body">
            {speak.exchanges.length === 0 && <p className="vl-dim">Nothing said yet.</p>}
            {speak.exchanges.map((e) => (
              <div key={e.id} className="vl-exchange">
                <p className="you">{e.said}</p>
                <p>{e.answer}{!e.done && <span aria-hidden>▌</span>}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="vl-bar">
        <span className="vl-bar-state">■ VOICE LINK · {STATE[speak.phase]}</span>
        <span className="vl-bar-copy">
          {speak.blocked !== undefined
            ? <>{speak.blocked} <Link href={`/w/${workspaceId}/models`}>Models</Link></>
            : speak.error ?? (speak.phase === 'listening' ? 'Speak, then press Stop.' : 'Press Start and speak. Voice continues this conversation.')}
        </span>
        <label className="vl-toggle"><input type="checkbox" checked={speak.readAloud} onChange={(e) => speak.setReadAloud(e.target.checked)} /> READ ALOUD</label>
        <button
          type="button" className={`vl-start${speak.phase === 'listening' ? ' live' : ''}`}
          disabled={speak.blocked !== undefined || busy}
          onClick={() => (speak.phase === 'listening' ? speak.stop() : void speak.start())}
        >
          <Icon name="mic" size={15} /> {speak.phase === 'listening' ? 'STOP' : busy ? 'WAIT' : 'START'}
        </button>
        <button type="button" className="vl-more" aria-label={showText ? 'Hide transcript' : 'Show transcript'} aria-pressed={showText} onClick={() => setShowText((v) => !v)}>
          <Icon name="chevron" size={14} />
        </button>
      </footer>
    </div>
  );
}

function Vital({ label, value, ratio }: { label: string; value: string; ratio: number }) {
  return (
    <div className="vl-vital">
      <div><span>{label}</span><span>{value}</span></div>
      <div className="vl-meter"><span style={{ width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%` }} /></div>
    </div>
  );
}

function clock(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/**
 * The circle: tick ring, an arc that follows the microphone, and a slowly
 * turning sphere of points that breathes while the assistant speaks.
 */
function Orb({ phase, level, analyser }: { phase: Phase; level: number; analyser: () => AnalyserNode | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ phase, level });
  state.current = { phase, level };

  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    const ctx = el.getContext('2d');
    if (ctx === null) return;
    const points = Array.from({ length: 220 }, () => {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      return { x: r * Math.cos(t), y: u, z: r * Math.sin(t) };
    });
    let frame = 0;
    let angle = 0;
    let spin = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== w * dpr || el.height !== h * dpr) { el.width = w * dpr; el.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.42;
      const { phase: p, level: lv } = state.current;

      // Tick ring with headings.
      ctx.strokeStyle = 'rgba(96,165,250,0.45)';
      ctx.fillStyle = 'rgba(96,165,250,0.7)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (let i = 0; i < 72; i += 1) {
        const a = (i / 72) * Math.PI * 2 - Math.PI / 2;
        const long = i % 6 === 0;
        const r1 = R * 1.12;
        const r2 = r1 + (long ? 14 : 6);
        ctx.lineWidth = long ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        ctx.stroke();
        if (long) ctx.fillText(String((i / 6) * 30).padStart(3, '0'), cx + Math.cos(a) * (r2 + 12), cy + Math.sin(a) * (r2 + 12) + 3);
      }
      // Dashed inner ring.
      ctx.setLineDash([3, 9]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(96,165,250,0.35)';
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);

      // The arc: follows the level while listening, turns while thinking, breathes while speaking.
      let span: number;
      if (p === 'listening') span = 0.15 + lv * 1.6;
      else if (p === 'hearing' || p === 'answering') { spin += 0.03; span = 0.9; }
      else if (p === 'speaking') span = 1.2 + Math.sin(angle * 6) * 0.4;
      else span = 1.45;
      const start = -Math.PI / 2 + (p === 'hearing' || p === 'answering' ? spin : 0);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(245,158,11,0.9)';
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.94, start, start + span * Math.PI); ctx.stroke();

      // The sphere.
      angle += 0.0035;
      const bulge = p === 'speaking' ? 1 + Math.sin(angle * 9) * 0.05 : p === 'listening' ? 1 + lv * 0.12 : 1;
      const r = R * 0.62 * bulge;
      const projected = points.map((pt) => {
        const x = pt.x * Math.cos(angle) - pt.z * Math.sin(angle);
        const z = pt.x * Math.sin(angle) + pt.z * Math.cos(angle);
        return { x: cx + x * r, y: cy + pt.y * r, z };
      });
      ctx.strokeStyle = 'rgba(147,197,253,0.14)';
      ctx.lineWidth = 0.6;
      for (let i = 0; i < projected.length; i += 1) {
        const a = projected[i]!;
        for (let j = i + 1; j < projected.length; j += 7) {
          const b = projected[j]!;
          const dx = a.x - b.x; const dy = a.y - b.y;
          if (dx * dx + dy * dy < r * r * 0.09) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        }
      }
      for (const pt of projected) {
        const depth = (pt.z + 1) / 2;
        ctx.fillStyle = `rgba(226,232,240,${0.25 + depth * 0.7})`;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 0.8 + depth * 1.4, 0, Math.PI * 2); ctx.fill();
      }
      void analyser;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  return <canvas ref={canvas} className="vl-orb" aria-hidden />;
}

/** The microphone's spectrum, as bars. Flat when nothing is being recorded. */
function Spectrum({ analyser, active }: { analyser: () => AnalyserNode | undefined; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    const ctx = el.getContext('2d');
    if (ctx === null) return;
    let frame = 0;
    const bins = new Uint8Array(64);
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth; const h = el.clientHeight;
      if (el.width !== w * dpr || el.height !== h * dpr) { el.width = w * dpr; el.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const a = active ? analyser() : undefined;
      if (a !== undefined) { const data = new Uint8Array(a.frequencyBinCount); a.getByteFrequencyData(data); for (let i = 0; i < 64; i += 1) bins[i] = data[Math.floor((i / 64) * data.length)] ?? 0; }
      else bins.fill(0);
      const bw = w / 64;
      for (let i = 0; i < 64; i += 1) {
        const v = (bins[i] ?? 0) / 255;
        const bh = 3 + v * (h - 6);
        ctx.fillStyle = `rgba(96,165,250,${0.35 + v * 0.65})`;
        ctx.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser, active]);
  return <canvas ref={canvas} className="vl-spectrum" aria-hidden />;
}
