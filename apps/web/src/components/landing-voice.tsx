'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui';
import { say } from '@/lib/client/use-speak';

/**
 * The voice panel on the front door, live.
 *
 * Press the orb, ask something, press it again. The recording goes to the
 * public demo endpoint, which hears it and answers as Bee on the site owner's
 * OpenAI key, and the answer is read out in the browser's own voice. What was
 * heard is written down before the answer, as it is in the Speak tab.
 *
 * Until someone speaks the log shows an example exchange, marked as one. When
 * the site has no key set the panel says so and the button stays off, rather
 * than letting a visitor talk into nothing.
 */

type Phase = 'off' | 'idle' | 'listening' | 'hearing' | 'speaking';
interface Turn { said: string; answer: string }

const EXAMPLE: Turn = {
  said: 'what is waiting on me today?',
  answer: 'Three things. Okoro’s invoice query, Bright Lane’s quote, and Tunde’s delivery date. Want me to draft the replies?',
};

/** Long enough for a question; the endpoint refuses much more. */
const MAX_RECORDING_MS = 15_000;
const BARS = 32;

const STATUS: Record<Phase, string> = {
  off: 'DEMO OFF',
  idle: 'READY',
  listening: 'LISTENING',
  hearing: 'THINKING',
  speaking: 'SPEAKING',
};

export function LandingVoice() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string>();
  const [levels, setLevels] = useState<number[]>(() => restingBars());
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const meter = useRef<{ context: AudioContext; frame: number } | null>(null);
  const cutoff = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('/api/demo/voice')
      .then((r) => r.json() as Promise<{ available?: boolean }>)
      .then((body) => { if (body.available !== true) setPhase('off'); })
      .catch(() => setPhase('off'));
    return () => {
      stopMeter();
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    };
  }, []);

  function stopMeter() {
    const m = meter.current;
    if (m === null) return;
    cancelAnimationFrame(m.frame);
    void m.context.close().catch(() => undefined);
    meter.current = null;
    setLevels(restingBars());
  }

  const send = useCallback(async (blob: Blob) => {
    if (blob.size < 1_000) {
      setPhase('idle');
      setError('That was too short to hear. Press, ask your question, then press again.');
      return;
    }
    setPhase('hearing');
    try {
      const form = new FormData();
      const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      form.set('audio', new File([blob], `speech.${extension}`, { type: blob.type }));
      const response = await fetch('/api/demo/voice', { method: 'POST', body: form });
      const body = await response.json().catch(() => undefined) as
        { transcript?: string; answer?: string; error?: { message?: string } } | undefined;
      if (!response.ok || body?.answer === undefined) {
        setPhase(response.status === 503 ? 'off' : 'idle');
        setError(body?.error?.message ?? 'The demo did not answer. Try again in a moment.');
        return;
      }
      setTurns((current) => [...current.slice(-2), { said: body.transcript ?? '', answer: body.answer ?? '' }]);
      setPhase('speaking');
      say(body.answer, () => setPhase('idle'));
    } catch {
      setPhase('idle');
      setError('Could not reach the demo. Check your connection and try again.');
    }
  }, []);

  const start = useCallback(async () => {
    setError(undefined);
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    if (navigator.mediaDevices?.getUserMedia === undefined || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio. Try a recent Chrome, Edge, Firefox or Safari.');
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(media, mimeType === undefined ? {} : { mimeType });
      chunks.current = [];
      rec.ondataavailable = (event) => { if (event.data.size > 0) chunks.current.push(event.data); };
      rec.onstop = () => {
        media.getTracks().forEach((track) => track.stop());
        stopMeter();
        if (cutoff.current !== null) { clearTimeout(cutoff.current); cutoff.current = null; }
        void send(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' }));
      };
      recorder.current = rec;
      rec.start();
      cutoff.current = setTimeout(() => stop(), MAX_RECORDING_MS);

      // The bars are the microphone: what moves is what it hears.
      try {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 64;
        context.createMediaStreamSource(media).connect(analyser);
        const bins = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(bins);
          setLevels(Array.from({ length: BARS }, (_, i) => 8 + Math.round(((bins[i % bins.length] ?? 0) / 255) * 92)));
          if (meter.current !== null) meter.current.frame = requestAnimationFrame(tick);
        };
        meter.current = { context, frame: requestAnimationFrame(tick) };
      } catch {
        // No meter: the recording still works.
      }
      setPhase('listening');
    } catch (caught) {
      setError(caught instanceof Error && caught.name === 'NotAllowedError'
        ? 'The browser did not allow the microphone. Allow it for this site and try again.'
        : 'Could not start the microphone.');
    }
  }, [send]);

  function stop() {
    recorder.current?.stop();
    recorder.current = null;
  }

  const busy = phase === 'hearing' || phase === 'speaking';
  const shown = turns.length === 0 ? [EXAMPLE] : turns;
  const label = phase === 'off' ? 'The voice demo is off'
    : phase === 'listening' ? 'Stop and send'
      : busy ? 'Bee is answering' : 'Press and ask Bee something';

  return (
    <div className={`mock-voice live-voice is-${phase}`}>
      <div className="mock-voice-top">
        <span>BEE // VOICE LINK</span>
        <span className="mock-voice-live" aria-live="polite">{STATUS[phase]}</span>
      </div>
      <button
        type="button" className="mock-voice-orb live-voice-orb"
        aria-label={label} title={label}
        disabled={phase === 'off' || busy}
        onClick={() => { if (phase === 'listening') stop(); else void start(); }}
      >
        <span className="mock-voice-ring" />
        <span className="mock-voice-core" />
        <span className="live-voice-icon"><Icon name="mic" size={30} /></span>
      </button>
      <p className="live-voice-hint">
        {phase === 'off'
          ? 'The live demo is switched off right now. Sign up to talk to your own assistant.'
          : phase === 'listening' ? 'Listening. Press again when you have finished.'
            : phase === 'hearing' ? 'Hearing you, then thinking…'
              : phase === 'speaking' ? 'Answering out loud.'
                : 'Press the orb and ask what it can do for your business.'}
      </p>
      <div className="mock-voice-bars" aria-hidden>
        {levels.map((height, i) => <span key={i} style={{ height: `${height}%` }} />)}
      </div>
      {error !== undefined && <p className="live-voice-error" role="alert">{error}</p>}
      <div className="mock-voice-log" aria-live="polite">
        {turns.length === 0 && <><span>eg.</span><p className="faint-line">An example. Yours appears here.</p></>}
        {shown.map((turn, i) => (
          <Exchange key={i} turn={turn} />
        ))}
      </div>
    </div>
  );
}

function Exchange({ turn }: { turn: Turn }) {
  return (
    <>
      <span>you</span><p>{turn.said}</p>
      <span>bee</span><p>{turn.answer}</p>
    </>
  );
}

/** The bars at rest: a still wave, so the panel never looks broken. */
function restingBars(): number[] {
  return Array.from({ length: BARS }, (_, i) => 18 + Math.round(72 * Math.abs(Math.sin(i * 0.7 + 0.4))) / 3);
}
