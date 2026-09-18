'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, ws } from '@/lib/client/api';
import { useRunStream } from '@/lib/client/use-run-stream';
import { Icon } from '@/components/ui';

/**
 * Talking to an assistant.
 *
 * Tap to record, tap to stop. The recording goes to the workspace's
 * transcription model; what it HEARD comes back first and is shown before the
 * answer, because transcription is the one step that can silently replace what
 * you said, and only you can catch it. The reply arrives over the same stream
 * a typed message would, and the browser's own voice reads it out — no third
 * party hears the conversation to speak it.
 *
 * Spoken turns live in one conversation per assistant, titled "Spoken", so
 * they appear in Chat too and the assistant remembers what was said.
 */

interface Exchange { id: string; said: string; answer: string; done: boolean }
interface Conversation { id: string; agentId: string; title: string }

const SPOKEN_TITLE = 'Spoken';

type Phase = 'idle' | 'listening' | 'hearing' | 'answering';

export function SpeakTab({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [runId, setRunId] = useState<string>();
  const [readAloud, setReadAloud] = useState(true);
  const [error, setError] = useState<string>();
  const [unconfigured, setUnconfigured] = useState(false);
  const recorder = useRef<MediaRecorder>(null);
  const chunks = useRef<Blob[]>([]);
  const conversationId = useRef<string>(null);

  const canRecord = typeof navigator !== 'undefined'
    && navigator.mediaDevices?.getUserMedia !== undefined
    && typeof MediaRecorder !== 'undefined';

  const stream = useRunStream(workspaceId, runId, () => {
    setPhase('idle');
    setRunId(undefined);
  });

  // The streamed answer, written into the current exchange as it arrives, and
  // spoken once it is complete — a sentence read out mid-stream is read twice.
  useEffect(() => {
    if (runId === undefined) return;
    setExchanges((current) => current.map((e, i) =>
      i === current.length - 1 ? { ...e, answer: stream.text, done: stream.status === 'finished' } : e));
    if (stream.status === 'finished' && readAloud && stream.text.trim() !== '') say(stream.text);
  }, [stream.text, stream.status, runId, readAloud]);

  const conversation = useCallback(async (): Promise<string> => {
    if (conversationId.current !== null) return conversationId.current;
    const list = await api.get<{ items: Conversation[] }>(`${ws(workspaceId)}/conversations`);
    const existing = list.items.find((c) => c.agentId === agentId && c.title === SPOKEN_TITLE);
    const id = existing?.id ?? (await api.post<{ id: string }>(
      `${ws(workspaceId)}/conversations`, { agentId, title: SPOKEN_TITLE },
    )).id;
    conversationId.current = id;
    return id;
  }, [workspaceId, agentId]);

  async function start() {
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
        void send(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' }));
      };
      recorder.current = rec;
      rec.start();
      setPhase('listening');
    } catch (caught) {
      setError(caught instanceof Error && caught.name === 'NotAllowedError'
        ? 'The browser did not allow the microphone. Allow it for this site and try again.'
        : 'Could not start recording.');
    }
  }

  function stop() {
    recorder.current?.stop();
    recorder.current = null;
  }

  async function send(blob: Blob) {
    if (blob.size < 1_000) {
      setPhase('idle');
      setError('That was too short to hear. Hold the button a little longer.');
      return;
    }
    setPhase('hearing');
    try {
      const id = await conversation();
      const form = new FormData();
      const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      form.set('audio', new File([blob], `speech.${extension}`, { type: blob.type }));
      const result = await api.upload<{ transcript: string; runId: string }>(
        `${ws(workspaceId)}/conversations/${id}/speak`, form,
      );
      setExchanges((current) => [...current, { id: result.runId, said: result.transcript, answer: '', done: false }]);
      setRunId(result.runId);
      setPhase('answering');
    } catch (caught) {
      setPhase('idle');
      if (caught instanceof ApiError && caught.code === 'unsupported') setUnconfigured(true);
      else setError(caught instanceof Error ? caught.message : 'Could not send that.');
    }
  }

  if (!canRecord) {
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
    <div className="speak">
      <div className="speak-log">
        {exchanges.length === 0 && phase === 'idle' && (
          <p className="muted" style={{ textAlign: 'center', margin: '48px 0 0' }}>
            Tap the button and say something. You will see what was heard before the answer.
          </p>
        )}
        {exchanges.map((e) => (
          <div key={e.id} className="speak-exchange">
            <div className="msg user"><div className="who">You said</div><div className="body">{e.said}</div></div>
            <div className="msg assistant">
              <div className="who">Answer</div>
              <div className="body">
                {e.answer}
                {!e.done && <span aria-hidden>▌</span>}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="speak-controls">
        {unconfigured && (
          <div className="note" style={{ marginBottom: 12 }}>
            <span className="tile" aria-hidden><Icon name="spark" size={16} /></span>
            <span>
              No model is set up to listen yet. Connecting OpenAI binds one; otherwise bind a
              model to the <strong>transcription</strong> role on the{' '}
              <Link href={`/w/${workspaceId}/models`}>Models page</Link>.
            </span>
          </div>
        )}
        {error !== undefined && <p className="error" style={{ marginBottom: 10 }}>{error}</p>}

        <button
          type="button"
          className={`mic ${phase}`}
          aria-label={phase === 'listening' ? 'Stop recording' : 'Start recording'}
          disabled={phase === 'hearing' || phase === 'answering'}
          onClick={() => (phase === 'listening' ? stop() : void start())}
        >
          <Icon name="mic" size={26} />
        </button>
        <p className="muted speak-status">
          {phase === 'idle' && 'Tap to talk'}
          {phase === 'listening' && 'Listening… tap to stop'}
          {phase === 'hearing' && 'Hearing you…'}
          {phase === 'answering' && 'Thinking…'}
        </p>
        <label className="speak-toggle">
          <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
          Read answers aloud
        </label>
      </div>
    </div>
  );
}

/** The browser's own voice. Cancels anything still being read first. */
function say(text: string): void {
  if (typeof speechSynthesis === 'undefined') return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
