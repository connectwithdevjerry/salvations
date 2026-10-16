'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { answerFor } from '@/lib/client/landing-brain';

/**
 * The voice console on the front door, live.
 *
 * Press the button and talk: the browser's own speech recognition hears
 * you, a scripted brain answers from this page, and the browser's own
 * voice reads it back. No key, no server, nothing sent anywhere, which is
 * why a stranger may use it. The bars are the real level on the
 * microphone, and the log is what was actually heard and said.
 *
 * Said plainly on the console that it is a demo: the real Speak tab runs
 * on the person's own key and does real work. A browser that cannot hear
 * (Firefox, at the time of writing) gets the still picture and a line
 * saying which browsers can.
 */
type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Line { readonly who: 'you' | 'hive'; readonly text: string }

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const OPENING: readonly Line[] = [
  { who: 'you', text: 'what is waiting on me today?' },
  { who: 'hive', text: 'Three things. Okoro’s invoice query, Bright Lane’s quote, and Tunde’s delivery date. Want me to draft the replies?' },
];

const BARS = 32;

export function LandingVoice() {
  const [supported, setSupported] = useState<boolean>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<readonly Line[]>(OPENING);
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState<string>();
  const recognition = useRef<RecognitionLike>(null);
  const meter = useRef<{ context: AudioContext; stream: MediaStream; frame: number }>(null);

  useEffect(() => { setSupported(recognitionCtor() !== undefined); }, []);

  const stopMeter = useCallback(() => {
    const m = meter.current;
    if (m === null) return;
    cancelAnimationFrame(m.frame);
    m.stream.getTracks().forEach((t) => t.stop());
    void m.context.close().catch(() => undefined);
    meter.current = null;
    setLevel(0);
  }, []);

  /** The real level on the microphone, for the bars. Best effort: hearing works without it. */
  const startMeter = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const v of buffer) { const d = (v - 128) / 128; sum += d * d; }
        setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 4));
        if (meter.current !== null) meter.current.frame = requestAnimationFrame(tick);
      };
      meter.current = { context, stream, frame: requestAnimationFrame(tick) };
    } catch { /* no meter, still hearing */ }
  }, []);

  const speak = useCallback((text: string) => {
    setPhase('speaking');
    if (typeof speechSynthesis === 'undefined') { setPhase('idle'); return; }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setPhase('idle');
    utterance.onerror = () => setPhase('idle');
    speechSynthesis.speak(utterance);
  }, []);

  const stop = useCallback(() => {
    recognition.current?.abort();
    recognition.current = null;
    stopMeter();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    setPhase('idle');
  }, [stopMeter]);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (Ctor === undefined) return;
    setNote(undefined);
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      const heard = event.results[0]?.[0]?.transcript ?? '';
      stopMeter();
      setPhase('thinking');
      const answer = answerFor(heard);
      setLines((current) => [...current.slice(-4), { who: 'you', text: heard }, { who: 'hive', text: answer }]);
      // A beat, so "thinking" is seen; the answer itself is instant.
      setTimeout(() => speak(answer), 350);
    };
    rec.onerror = (event) => {
      stopMeter();
      setPhase('idle');
      setNote(event.error === 'not-allowed'
        ? 'The microphone was refused. Allow it for this site and try again.'
        : event.error === 'no-speech'
          ? 'I heard nothing. Press Start and speak straight away.'
          : 'Your browser could not hear that. Try again.');
    };
    rec.onend = () => { if (recognition.current === rec) recognition.current = null; };
    recognition.current = rec;
    setPhase('listening');
    void startMeter();
    try { rec.start(); } catch { setPhase('idle'); }
  }, [speak, startMeter, stopMeter]);

  useEffect(() => () => { recognition.current?.abort(); stopMeter(); if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); }, [stopMeter]);

  const live = phase === 'listening';
  const status = phase === 'listening' ? 'LISTENING' : phase === 'thinking' ? 'THINKING' : phase === 'speaking' ? 'SPEAKING' : 'READY';

  return (
    <div className={`mock-voice live-voice ${phase}`}>
      <div className="mock-voice-top"><span>BEE // VOICE LINK</span><span className={live ? 'mock-voice-live' : 'mock-voice-idle'}>{status}</span></div>
      <div className="mock-voice-orb"><span className="mock-voice-ring" /><span className="mock-voice-core" style={{ transform: `scale(${1 + level * 0.35})` }} /></div>
      <div className="mock-voice-bars" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => {
          const shape = Math.abs(Math.sin(i * 0.7 + 0.4));
          const height = live ? 8 + Math.round(90 * level * shape) : 18 + Math.round(72 * shape * (phase === 'speaking' ? 0.6 : 0.35));
          return <span key={i} style={{ height: `${Math.max(4, height)}%` }} />;
        })}
      </div>
      <div className="mock-voice-log" aria-live="polite">
        {lines.map((line, i) => <Line key={`${i}-${line.who}`} line={line} />)}
      </div>
      {supported === false ? (
        <p className="mock-voice-note">This browser cannot hear. Chrome, Safari and Edge can; the real Speak tab works in all of them.</p>
      ) : (
        <div className="mock-voice-actions">
          <button
            type="button"
            className={live ? 'danger' : 'primary'}
            onClick={live ? stop : start}
            disabled={supported !== true || phase === 'thinking'}
            aria-label={live ? 'Stop listening' : 'Start talking to the demo'}
          >
            {live ? '■ Stop' : phase === 'speaking' ? '● Ask again' : '● Start, and ask it something'}
          </button>
          <span className="mock-voice-note">{note ?? 'A demo in your browser: scripted answers, nothing sent anywhere. The real thing runs on your key.'}</span>
        </div>
      )}
    </div>
  );
}

function Line({ line }: { line: Line }) {
  return (
    <>
      <span>{line.who === 'you' ? 'you' : 'bee'}</span>
      <p>{line.text}</p>
    </>
  );
}
