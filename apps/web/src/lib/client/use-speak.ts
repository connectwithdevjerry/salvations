'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, ws } from '@/lib/client/api';
import { useRunStream } from '@/lib/client/use-run-stream';

/**
 * Talking to an assistant: the mechanics, apart from the screen.
 *
 * Record, send, hear what was heard, stream the answer, read it out. What
 * the hook also keeps is what a voice screen can honestly show: the
 * microphone level while listening, how long each reply took, how many
 * turns there have been, and a log of what actually happened. Nothing here
 * is invented for effect.
 */

export interface Exchange { id: string; said: string; answer: string; done: boolean; sentAt: number; repliedAt?: number }
export interface LogLine { at: number; kind: 'ok' | 'info' | 'err'; text: string }
interface Conversation { id: string; agentId: string; title: string }

const SPOKEN_TITLE = 'Spoken';
export type Phase = 'idle' | 'listening' | 'hearing' | 'answering' | 'speaking';

export function useSpeak(workspaceId: string, agentId: string) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [runId, setRunId] = useState<string>();
  const [readAloud, setReadAloud] = useState(true);
  const [error, setError] = useState<string>();
  const [blocked, setBlocked] = useState<string>();
  const [log, setLog] = useState<LogLine[]>([]);
  const [level, setLevel] = useState(0);
  const [sampleRate, setSampleRate] = useState<number>();
  const [conversationId, setConversationId] = useState<string>();
  const recorder = useRef<MediaRecorder>(null);
  const chunks = useRef<Blob[]>([]);
  const audio = useRef<{ context: AudioContext; analyser: AnalyserNode; frame: number }>(null);
  const spectrum = useRef<Uint8Array<ArrayBuffer>>(new Uint8Array(0));

  const canRecord = typeof navigator !== 'undefined'
    && navigator.mediaDevices?.getUserMedia !== undefined
    && typeof MediaRecorder !== 'undefined';

  const note = useCallback((kind: LogLine['kind'], text: string) => {
    setLog((current) => [...current.slice(-60), { at: Date.now(), kind, text }]);
  }, []);

  const stream = useRunStream(workspaceId, runId, () => {
    setRunId(undefined);
  });

  // The streamed answer, written into the current exchange as it arrives, and
  // spoken once it is complete: a sentence read out mid-stream is read twice.
  useEffect(() => {
    if (runId === undefined) return;
    setExchanges((current) => current.map((e, i) =>
      i === current.length - 1 ? { ...e, answer: stream.text, done: stream.status === 'finished' } : e));
  }, [stream.text, stream.status, runId]);

  const toolsSeen = useRef(0);
  useEffect(() => {
    if (stream.toolCalls.length > toolsSeen.current) {
      for (const call of stream.toolCalls.slice(toolsSeen.current)) note('info', `tool ${call.name}`);
      toolsSeen.current = stream.toolCalls.length;
    }
  }, [stream.toolCalls, note]);

  useEffect(() => {
    if (runId === undefined || stream.status !== 'finished') return;
    const finishedAt = Date.now();
    setExchanges((current) => current.map((e, i) => (i === current.length - 1 ? { ...e, repliedAt: finishedAt } : e)));
    const last = exchanges[exchanges.length - 1];
    if (last !== undefined) note('ok', `replied in ${((finishedAt - last.sentAt) / 1000).toFixed(1)}s`);
    if (readAloud && stream.text.trim() !== '') {
      setPhase('speaking');
      say(stream.text, () => setPhase('idle'));
    } else {
      setPhase('idle');
    }
    toolsSeen.current = 0;
    // The exchanges list is read once here, at the moment of finishing.
  }, [stream.status, runId]);

  useEffect(() => {
    if (stream.status === 'error' && runId !== undefined) { note('err', 'the stream dropped; reconnecting'); }
  }, [stream.status, runId, note]);

  const conversation = useCallback(async (): Promise<string> => {
    if (conversationId !== undefined) return conversationId;
    const list = await api.get<{ items: Conversation[] }>(`${ws(workspaceId)}/conversations`);
    const existing = list.items.find((c) => c.agentId === agentId && c.title === SPOKEN_TITLE);
    const id = existing?.id ?? (await api.post<{ id: string }>(
      `${ws(workspaceId)}/conversations`, { agentId, title: SPOKEN_TITLE },
    )).id;
    setConversationId(id);
    return id;
  }, [workspaceId, agentId, conversationId]);

  const stopMeter = () => {
    const a = audio.current;
    if (a === null) return;
    cancelAnimationFrame(a.frame);
    void a.context.close().catch(() => undefined);
    audio.current = null;
    setLevel(0);
  };

  const start = useCallback(async () => {
    setError(undefined);
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
        void send(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' }));
      };
      recorder.current = rec;
      rec.start();

      // A meter on the same stream: the level the screen shows is the level.
      try {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(media).connect(analyser);
        spectrum.current = new Uint8Array(analyser.frequencyBinCount);
        setSampleRate(context.sampleRate);
        const tick = () => {
          analyser.getByteTimeDomainData(spectrum.current);
          let sum = 0;
          for (const v of spectrum.current) { const d = (v - 128) / 128; sum += d * d; }
          setLevel(Math.min(1, Math.sqrt(sum / spectrum.current.length) * 4));
          if (audio.current !== null) audio.current.frame = requestAnimationFrame(tick);
        };
        audio.current = { context, analyser, frame: requestAnimationFrame(tick) };
      } catch {
        // No meter: the recording still works.
      }

      setPhase('listening');
      note('ok', 'listening');
    } catch (caught) {
      setError(caught instanceof Error && caught.name === 'NotAllowedError'
        ? 'The browser did not allow the microphone. Allow it for this site and try again.'
        : 'Could not start recording.');
      note('err', 'microphone refused');
    }
    // `send` closes over the same ids; the callback is re-created only with them.
  }, [workspaceId, agentId, note]);

  const stop = useCallback(() => {
    recorder.current?.stop();
    recorder.current = null;
  }, []);

  async function send(blob: Blob) {
    if (blob.size < 1_000) {
      setPhase('idle');
      setError('That was too short to hear. Hold the button a little longer.');
      note('err', 'too short to hear');
      return;
    }
    setPhase('hearing');
    note('info', `sending ${(blob.size / 1024).toFixed(0)} KB`);
    try {
      const id = await conversation();
      const form = new FormData();
      const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      form.set('audio', new File([blob], `speech.${extension}`, { type: blob.type }));
      const result = await api.upload<{ transcript: string; runId: string }>(
        `${ws(workspaceId)}/conversations/${id}/speak`, form,
      );
      note('ok', `heard: ${result.transcript.length > 60 ? `${result.transcript.slice(0, 59)}…` : result.transcript}`);
      setExchanges((current) => [...current, { id: result.runId, said: result.transcript, answer: '', done: false, sentAt: Date.now() }]);
      setRunId(result.runId);
      setPhase('answering');
      note('info', 'thinking');
    } catch (caught) {
      setPhase('idle');
      if (caught instanceof ApiError && (caught.code === 'unsupported' || caught.code === 'provider_error')) {
        setBlocked(caught.message);
        note('err', caught.message);
      } else {
        const message = caught instanceof Error ? caught.message : 'Could not send that.';
        setError(message);
        note('err', message);
      }
    }
  }

  useEffect(() => () => { stopMeter(); if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); }, []);

  const analyser = () => audio.current?.analyser;

  return {
    canRecord, phase, exchanges, readAloud, setReadAloud, error, blocked, log, level, sampleRate, conversationId,
    start, stop, analyser,
    toolCalls: stream.toolCalls,
  };
}

/** The browser's own voice. Cancels anything still being read first. */
function say(text: string, done: () => void): void {
  if (typeof speechSynthesis === 'undefined') { done(); return; }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onend = done;
  utterance.onerror = done;
  speechSynthesis.speak(utterance);
}
