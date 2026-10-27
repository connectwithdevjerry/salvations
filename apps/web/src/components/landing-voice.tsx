'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { answerFor } from '@/lib/client/landing-brain';

/**
 * The voice console on the front door, live.
 *
 * Press Start and talk. When the deployment holds an OpenAI key for it
 * (Deployment settings → Landing page voice, or HIVE AI's own when that runs
 * on OpenAI), the recording goes to /api/demo/voice: OpenAI hears it, Bee
 * answers, and the browser reads the answer out. That works in every browser
 * with a microphone, Firefox included, and stops by itself when the visitor
 * goes quiet.
 *
 * Without a key the console falls back to what it did before: the browser's
 * own speech recognition and scripted answers from this page, nothing sent
 * anywhere. A browser that can do neither gets the still picture and a line
 * saying why. The bars are the real level on the microphone either way, and
 * the log is what was actually heard and said.
 */
type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';
/** How this browser, on this deployment, hears the visitor. Undecided until mounted. */
type Mode = 'openai' | 'browser' | 'none';

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

const canRecord = (): boolean =>
  typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined && typeof MediaRecorder !== 'undefined';

const OPENING: readonly Line[] = [
  { who: 'you', text: 'what is waiting on me today?' },
  { who: 'hive', text: 'Three things. Okoro’s invoice query, Bright Lane’s quote, and Tunde’s delivery date. Want me to draft the replies?' },
];

const BARS = 32;
/** A question, not a monologue; the endpoint refuses much more. */
const MAX_RECORDING_MS = 15_000;
/** Once the visitor has spoken, this much quiet sends what they said. */
const QUIET_MS = 1_400;
const SPEAKING_LEVEL = 0.12;
const QUIET_LEVEL = 0.05;

export function LandingVoice() {
  const [mode, setMode] = useState<Mode>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<readonly Line[]>(OPENING);
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState<string>();
  const recognition = useRef<RecognitionLike>(null);
  const recorder = useRef<MediaRecorder>(null);
  const chunks = useRef<Blob[]>([]);
  const cutoff = useRef<ReturnType<typeof setTimeout>>(null);
  const meter = useRef<{ context: AudioContext; stream: MediaStream; frame: number }>(null);

  useEffect(() => {
    const fallback = (): Mode => (recognitionCtor() !== undefined ? 'browser' : 'none');
    fetch('/api/demo/voice', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() as Promise<{ available?: boolean }> : { available: false }))
      .then((body) => setMode(body.available === true && canRecord() ? 'openai' : fallback()))
      .catch(() => setMode(fallback()));
  }, []);

  const stopMeter = useCallback(() => {
    const m = meter.current;
    if (m === null) return;
    cancelAnimationFrame(m.frame);
    m.stream.getTracks().forEach((t) => t.stop());
    void m.context.close().catch(() => undefined);
    meter.current = null;
    setLevel(0);
  }, []);

  /**
   * The real level on the microphone, for the bars. Best effort: hearing
   * works without it. `onLevel` sees every frame, which is how the OpenAI
   * path notices the visitor has stopped talking.
   */
  const startMeter = useCallback((stream: MediaStream, onLevel?: (level: number) => void) => {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const v of buffer) { const d = (v - 128) / 128; sum += d * d; }
        const now = Math.min(1, Math.sqrt(sum / buffer.length) * 4);
        setLevel(now);
        onLevel?.(now);
        if (meter.current !== null) meter.current.frame = requestAnimationFrame(tick);
      };
      meter.current = { context, stream, frame: requestAnimationFrame(tick) };
    } catch {
      // No meter; stop the tracks with the recording instead.
      meter.current = null;
    }
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

  const heard = useCallback((said: string, answer: string) => {
    setLines((current) => [...current.slice(-4), { who: 'you', text: said }, { who: 'hive', text: answer }]);
  }, []);

  /* ------------------------------------------------------------ OpenAI -- */

  const send = useCallback(async (blob: Blob) => {
    if (blob.size < 1_000) {
      setPhase('idle');
      setNote('That was too short to hear. Press Start and ask your question.');
      return;
    }
    setPhase('thinking');
    try {
      const form = new FormData();
      const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      form.set('audio', new File([blob], `speech.${extension}`, { type: blob.type }));
      const response = await fetch('/api/demo/voice', { method: 'POST', body: form });
      const body = await response.json().catch(() => undefined) as
        { transcript?: string; answer?: string; error?: { message?: string } } | undefined;
      if (!response.ok || body?.answer === undefined) {
        setPhase('idle');
        setNote(body?.error?.message ?? 'The demo did not answer. Try again in a moment.');
        // The key went away since the page loaded: the scripted console still works.
        if (response.status === 503) setMode(recognitionCtor() !== undefined ? 'browser' : 'none');
        return;
      }
      heard(body.transcript ?? '', body.answer);
      speak(body.answer);
    } catch {
      setPhase('idle');
      setNote('Could not reach the demo. Check your connection and try again.');
    }
  }, [heard, speak]);

  const finishRecording = useCallback(() => {
    if (cutoff.current !== null) { clearTimeout(cutoff.current); cutoff.current = null; }
    const rec = recorder.current;
    recorder.current = null;
    if (rec !== null && rec.state !== 'inactive') rec.stop();
  }, []);

  const startRecording = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (caught) {
      setNote(caught instanceof Error && caught.name === 'NotAllowedError'
        ? 'The microphone was refused. Allow it for this site and try again.'
        : 'Could not start the microphone.');
      return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
      .find((type) => MediaRecorder.isTypeSupported(type));
    const rec = new MediaRecorder(stream, mimeType === undefined ? {} : { mimeType });
    chunks.current = [];
    rec.ondataavailable = (event) => { if (event.data.size > 0) chunks.current.push(event.data); };
    rec.onstop = () => {
      stopMeter();
      stream.getTracks().forEach((t) => t.stop());
      void send(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' }));
    };
    recorder.current = rec;
    rec.start();
    cutoff.current = setTimeout(finishRecording, MAX_RECORDING_MS);

    // Sent by itself once the visitor has said something and then gone quiet.
    let spoke = false;
    let quietSince: number | undefined;
    startMeter(stream, (now) => {
      if (now >= SPEAKING_LEVEL) { spoke = true; quietSince = undefined; return; }
      if (!spoke || now > QUIET_LEVEL) return;
      quietSince ??= performance.now();
      if (performance.now() - quietSince >= QUIET_MS) finishRecording();
    });
    setPhase('listening');
  }, [finishRecording, send, startMeter, stopMeter]);

  /* ----------------------------------------------------------- browser -- */

  const startRecognition = useCallback(() => {
    const Ctor = recognitionCtor();
    if (Ctor === undefined) return;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      const said = event.results[0]?.[0]?.transcript ?? '';
      stopMeter();
      setPhase('thinking');
      const answer = answerFor(said);
      heard(said, answer);
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
    void navigator.mediaDevices?.getUserMedia({ audio: true })
      .then((stream) => startMeter(stream))
      .catch(() => undefined);
    try { rec.start(); } catch { setPhase('idle'); }
  }, [heard, speak, startMeter, stopMeter]);

  /* ------------------------------------------------------------ either -- */

  const start = useCallback(() => {
    setNote(undefined);
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    if (mode === 'openai') void startRecording();
    else if (mode === 'browser') startRecognition();
  }, [mode, startRecording, startRecognition]);

  /** Stop listening. On OpenAI that sends what was said; in the browser it abandons it. */
  const stop = useCallback(() => {
    if (recorder.current !== null) { finishRecording(); return; }
    recognition.current?.abort();
    recognition.current = null;
    stopMeter();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    setPhase('idle');
  }, [finishRecording, stopMeter]);

  useEffect(() => () => {
    if (cutoff.current !== null) clearTimeout(cutoff.current);
    if (recorder.current !== null) { recorder.current.onstop = null; if (recorder.current.state !== 'inactive') recorder.current.stop(); }
    recognition.current?.abort();
    stopMeter();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }, [stopMeter]);

  const live = phase === 'listening';
  const status = phase === 'listening' ? 'LISTENING' : phase === 'thinking' ? 'THINKING' : phase === 'speaking' ? 'SPEAKING' : 'READY';
  const idleNote = mode === 'openai'
    ? 'A live demo: OpenAI hears you and Bee answers. It sends when you stop talking. The real thing does the work.'
    : 'A demo in your browser: scripted answers, nothing sent anywhere. The real thing runs on your key.';

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
      {mode === 'none' ? (
        <p className="mock-voice-note">This browser cannot hear. Chrome, Safari and Edge can; the real Speak tab works in all of them.</p>
      ) : (
        <div className="mock-voice-actions">
          <button
            type="button"
            className={live ? 'danger' : 'primary'}
            onClick={live ? stop : start}
            disabled={mode === undefined || phase === 'thinking'}
            aria-label={live ? (mode === 'openai' ? 'Stop and send' : 'Stop listening') : 'Start talking to the demo'}
          >
            {live ? (mode === 'openai' ? '■ Done' : '■ Stop') : phase === 'speaking' ? '● Ask again' : '● Start, and ask it something'}
          </button>
          <span className="mock-voice-note">{note ?? idleNote}</span>
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
