'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { answerFor } from '@/lib/client/landing-brain';

/**
 * The voice console on the front door, live.
 *
 * Press Start and talk. With the deployment's OpenAI key, it is a live call
 * with Jarvis on OpenAI's Realtime model, speech to speech the way ChatGPT's
 * voice works: the browser connects to OpenAI over WebRTC on a key the
 * server minted for one call, the visitor can interrupt, and the call hangs
 * up by itself after a minute and a half. If the live call cannot start, the
 * console falls back to the next way down.
 *
 * When the deployment holds an OpenAI key for it
 * (Deployment settings → Landing page voice, or Yashayah's own when that runs
 * on OpenAI), the recording goes to /api/demo/voice: OpenAI hears it, Jarvis
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
type Mode = 'live' | 'openai' | 'browser' | 'none';

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

const canCall = (): boolean => typeof RTCPeerConnection !== 'undefined';

const canRecord = (): boolean =>
  typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined && typeof MediaRecorder !== 'undefined';

const OPENING: readonly Line[] = [
  { who: 'you', text: 'what is waiting on me today?' },
  { who: 'hive', text: 'Three things. Okoro’s invoice query, Bright Lane’s quote, and Tunde’s delivery date. Want me to draft the replies?' },
];

/**
 * The browser's closest thing to a composed British butler: a UK English male
 * voice where the system has one, else any UK English voice, else the default.
 */
function butlerVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').toLowerCase() === 'en-gb');
  return voices.find((v) => /\b(male|daniel|arthur|oliver|george|ryan|thomas)\b/i.test(v.name) && !/female/i.test(v.name))
    ?? voices[0];
}

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
  const call = useRef<{ pc: RTCPeerConnection; audio: HTMLAudioElement; stream: MediaStream; timer: ReturnType<typeof setInterval> }>(null);
  const [inCall, setInCall] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number>();

  useEffect(() => {
    const fallback = (): Mode => (recognitionCtor() !== undefined ? 'browser' : 'none');
    fetch('/api/demo/voice', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() as Promise<{ available?: boolean }> : { available: false }))
      .then((body) => setMode(body.available === true && canRecord() ? (canCall() ? 'live' : 'openai') : fallback()))
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
    const voice = butlerVoice();
    if (voice !== undefined) utterance.voice = voice;
    utterance.rate = 0.98;
    utterance.pitch = 0.9;
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

  /* -------------------------------------------------------------- live -- */

  const endCall = useCallback((why?: string) => {
    const c = call.current;
    call.current = null;
    if (c !== null) {
      clearInterval(c.timer);
      c.pc.getSenders().forEach((sender) => sender.track?.stop());
      c.pc.close();
      c.stream.getTracks().forEach((t) => t.stop());
      c.audio.srcObject = null;
    }
    stopMeter();
    setInCall(false);
    setSecondsLeft(undefined);
    setPhase('idle');
    if (why !== undefined) setNote(why);
  }, [stopMeter]);

  /** Down to hearing-then-answering, for this browser, when a live call cannot be had. */
  const fallBack = useCallback((why: string, detail?: unknown) => {
    if (detail !== undefined) console.warn('[landing-voice] live call unavailable:', detail);
    setMode('openai');
    setPhase('idle');
    setNote(`${why} Press Start again: it will hear you, then answer.`);
  }, []);

  const onEvent = useCallback((event: { type?: string; transcript?: string; error?: { message?: string } }) => {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        setPhase('listening');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) setLines((current) => [...current.slice(-5), { who: 'you', text: event.transcript!.trim() }]);
        break;
      // The first name is the current API's, the second the older one's.
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (event.transcript?.trim()) setLines((current) => [...current.slice(-5), { who: 'hive', text: event.transcript!.trim() }]);
        break;
      case 'output_audio_buffer.started':
        setPhase('speaking');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        setPhase('listening');
        break;
      case 'error':
        console.warn('[landing-voice]', event.error?.message);
        break;
      default:
        break;
    }
  }, []);

  const startCall = useCallback(async () => {
    setPhase('thinking');
    let session: { clientSecret?: string; maxSeconds?: number } | undefined;
    try {
      const response = await fetch('/api/demo/voice/live', { method: 'POST' });
      const body = await response.json().catch(() => undefined) as
        { clientSecret?: string; maxSeconds?: number; error?: { message?: string } } | undefined;
      if (response.status === 429) { setPhase('idle'); setNote(body?.error?.message ?? 'That is all for now. Try again later.'); return; }
      if (response.status === 503) { setPhase('idle'); setMode(recognitionCtor() !== undefined ? 'browser' : 'none'); setNote(body?.error?.message); return; }
      if (!response.ok || body?.clientSecret === undefined) { fallBack('The live call could not start.', body?.error?.message); return; }
      session = body;
    } catch (caught) {
      fallBack('Could not reach the live call.', caught);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (caught) {
      setPhase('idle');
      setNote(caught instanceof Error && caught.name === 'NotAllowedError'
        ? 'The microphone was refused. Allow it for this site and try again.'
        : 'Could not start the microphone.');
      return;
    }

    const pc = new RTCPeerConnection();
    const audio = new Audio();
    audio.autoplay = true;
    pc.ontrack = (event) => { audio.srcObject = event.streams[0] ?? null; };
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    const channel = pc.createDataChannel('oai-events');
    channel.onmessage = (message) => {
      try { onEvent(JSON.parse(String(message.data))); } catch { /* not ours to read */ }
    };
    const maxSeconds = session.maxSeconds ?? 90;
    const endsAt = Date.now() + maxSeconds * 1000;
    call.current = {
      pc, audio, stream,
      timer: setInterval(() => {
        const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
        setSecondsLeft(left);
        if (left === 0) endCall('The demo call ends after a minute and a half. Sign up to keep talking to your own assistant.');
      }, 1000),
    };
    pc.onconnectionstatechange = () => {
      if ((pc.connectionState === 'failed' || pc.connectionState === 'disconnected') && call.current?.pc === pc) {
        endCall('The call dropped. Press Start to call again.');
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp ?? '',
        headers: { authorization: `Bearer ${session.clientSecret}`, 'content-type': 'application/sdp' },
      });
      if (!answer.ok) throw new Error(`${answer.status} ${await answer.text().catch(() => '')}`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
    } catch (caught) {
      endCall();
      fallBack('The live call could not connect.', caught);
      return;
    }

    startMeter(stream);
    setSecondsLeft(maxSeconds);
    setInCall(true);
    setPhase('listening');
  }, [endCall, fallBack, onEvent, startMeter]);

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
    if (mode === 'live') void startCall();
    else if (mode === 'openai') void startRecording();
    else if (mode === 'browser') startRecognition();
  }, [mode, startCall, startRecording, startRecognition]);

  /** Stop listening. On OpenAI that sends what was said; in the browser it abandons it. */
  const stop = useCallback(() => {
    if (call.current !== null) { endCall(); return; }
    if (recorder.current !== null) { finishRecording(); return; }
    recognition.current?.abort();
    recognition.current = null;
    stopMeter();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    setPhase('idle');
  }, [endCall, finishRecording, stopMeter]);

  useEffect(() => () => {
    if (call.current !== null) {
      clearInterval(call.current.timer);
      call.current.pc.close();
      call.current.stream.getTracks().forEach((t) => t.stop());
      call.current = null;
    }
    if (cutoff.current !== null) clearTimeout(cutoff.current);
    if (recorder.current !== null) { recorder.current.onstop = null; if (recorder.current.state !== 'inactive') recorder.current.stop(); }
    recognition.current?.abort();
    stopMeter();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }, [stopMeter]);

  const live = phase === 'listening' || inCall;
  const status = (phase === 'listening' ? 'LISTENING' : phase === 'thinking' ? (mode === 'live' ? 'CONNECTING' : 'THINKING') : phase === 'speaking' ? 'SPEAKING' : 'READY')
    + (inCall && secondsLeft !== undefined ? ` · ${secondsLeft}s` : '');
  const idleNote = mode === 'live'
    ? 'A live call with Jarvis on OpenAI\'s realtime voice. Talk naturally and interrupt it any time; it hangs up after 90 seconds.'
    : mode === 'openai'
    ? 'A live demo: OpenAI hears you and Jarvis answers. It sends when you stop talking. The real thing does the work.'
    : 'A demo in your browser: scripted answers, nothing sent anywhere. The real thing runs on your key.';

  return (
    <div className={`mock-voice live-voice ${phase}`}>
      <div className="mock-voice-top"><span>JARVIS // VOICE LINK</span><span className={live ? 'mock-voice-live' : 'mock-voice-idle'}>{status}</span></div>
      <div className="mock-voice-orb"><span className="mock-voice-ring" /><span className="mock-voice-core" style={{ transform: `scale(${1 + level * 0.35})` }} /></div>
      <div className="mock-voice-bars" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => {
          const shape = Math.abs(Math.sin(i * 0.7 + 0.4));
          const height = live && phase !== 'speaking' ? 8 + Math.round(90 * level * shape) : 18 + Math.round(72 * shape * (phase === 'speaking' ? 0.6 : 0.35));
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
            disabled={mode === undefined || (phase === 'thinking' && !inCall)}
            aria-label={inCall ? 'End the call' : live ? (mode === 'openai' ? 'Stop and send' : 'Stop listening') : 'Start talking to the demo'}
          >
            {inCall ? '■ End call' : live ? (mode === 'openai' ? '■ Done' : '■ Stop') : phase === 'speaking' ? '● Ask again' : mode === 'live' ? '● Start a live call' : '● Start, and ask it something'}
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
      <span>{line.who === 'you' ? 'you' : 'jarvis'}</span>
      <p>{line.text}</p>
    </>
  );
}
