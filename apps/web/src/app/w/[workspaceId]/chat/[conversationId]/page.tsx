'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ws } from '@/lib/client/api';
import { useRunStream } from '@/lib/client/use-run-stream';
import { ApprovalPrompt } from '@/components/approval-prompt';

interface Block { type: string; text?: string; name?: string; isError?: boolean }
interface Message {
  id: string; seq: number; role: string; content: Block[]; runId?: string; createdAt: string;
}
interface ModelBinding { id: string; name: string; providerType: string; modelId: string }

const textOf = (content: Block[]): string =>
  content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

export default function ConversationPage({
  params,
}: {
  params: Promise<{ workspaceId: string; conversationId: string }>;
}) {
  const { workspaceId, conversationId } = use(params);
  const base = `${ws(workspaceId)}/conversations/${conversationId}`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<ModelBinding[]>([]);
  const [modelBindingId, setModelBindingId] = useState('');
  const [draft, setDraft] = useState('');
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState<string>();
  const logRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const result = await api.get<{
      conversation: { modelBindingId: string }; items: Message[];
    }>(`${base}/messages`);
    setMessages(result.items);
    setModelBindingId(result.conversation.modelBindingId);
  }, [base]);

  useEffect(() => { void reload().catch((e: Error) => setError(e.message)); }, [reload]);

  useEffect(() => {
    void api.get<{ items: ModelBinding[] }>(`${ws(workspaceId)}/models`)
      .then((r) => setModels(r.items))
      .catch(() => setModels([]));
  }, [workspaceId]);

  // Re-read the conversation when the run ends, so the streamed text is
  // replaced by the persisted message. The stream is a preview; the database is
  // the record, and leaving the preview on screen would quietly diverge from it.
  const stream = useRunStream(workspaceId, runId, () => {
    void reload().then(() => setRunId(undefined)).catch(() => undefined);
  });

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, stream.text]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (content === '' || runId !== undefined) return;

    setDraft('');
    setError(undefined);
    try {
      const result = await api.post<{ runId: string }>(`${base}/messages`, {
        content,
        modelBindingId,
        // Survives a double submit: the server derives the message id from it,
        // so a retry collides instead of appending twice.
        idempotencyKey: crypto.randomUUID(),
      });
      await reload();
      setRunId(result.runId);
    } catch (caught) {
      setDraft(content);
      setError(caught instanceof Error ? caught.message : 'Could not send that message.');
    }
  }

  const busy = runId !== undefined && stream.status !== 'finished';

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef}>
        <div className="row" style={{ marginBottom: 16 }}>
          <Link href={`/w/${workspaceId}/chat`} className="muted">← Conversations</Link>
          <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="muted">Model</span>
            <select
              value={modelBindingId}
              onChange={(e) => setModelBindingId(e.target.value)}
              disabled={busy}
              style={{ width: 'auto' }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name} · {m.modelId}</option>
              ))}
            </select>
          </label>
        </div>

        {messages.map((message) => (
          <MessageView key={message.id} message={message} workspaceId={workspaceId} />
        ))}

        {runId !== undefined && (
          <div className="msg assistant">
            <div className="who">Assistant</div>
            {stream.toolCalls.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                {stream.toolCalls.map((call) => (
                  <span key={call.id} className={`tool-chip${call.isError === true ? ' err' : ''}`}>
                    {call.finished ? (call.isError === true ? '✕' : '✓') : '…'} {call.name}
                  </span>
                ))}
              </div>
            )}
            <div className="body">
              {stream.text}
              {stream.status === 'streaming' && <span aria-hidden>▌</span>}
            </div>
            {stream.status === 'error' && (
              <p className="muted">Connection interrupted — reconnecting.</p>
            )}
            {stream.suspension?.approvalId !== undefined && (
              <ApprovalPrompt
                workspaceId={workspaceId}
                approvalId={stream.suspension.approvalId}
                onDecided={() => { void reload(); setRunId(undefined); }}
              />
            )}
            {stream.finish?.message !== undefined && (
              <p className="muted">Stopped: {stream.finish.message}</p>
            )}
          </div>
        )}
      </div>

      <div className="chat-form">
        {error !== undefined && <p className="error" style={{ marginBottom: 8 }}>{error}</p>}
        <form onSubmit={send}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={busy ? 'Waiting for the agent…' : 'Say something…'}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(e);
              }
            }}
          />
          <button className="primary" type="submit" disabled={busy || draft.trim() === ''}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function MessageView({ message, workspaceId }: { message: Message; workspaceId: string }) {
  if (message.role === 'tool') {
    const failed = message.content.filter((b) => b.isError === true).length;
    return (
      <div className="msg tool">
        <div className="body">
          {message.content.length} tool result{message.content.length === 1 ? '' : 's'}
          {failed > 0 && ` · ${failed} failed`}
        </div>
      </div>
    );
  }

  const text = textOf(message.content);
  const tools = message.content.filter((b) => b.type === 'tool_use');

  return (
    <div className={`msg ${message.role}`}>
      <div className="who">
        {message.role === 'user' ? 'You' : message.role === 'system' ? 'Summary' : 'Assistant'}
        {message.runId !== undefined && (
          <>
            {' · '}
            <Link href={`/w/${workspaceId}/runs/${message.runId}`} className="muted">
              run
            </Link>
          </>
        )}
      </div>
      {tools.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {tools.map((tool, index) => (
            <span key={index} className="tool-chip">{tool.name}</span>
          ))}
        </div>
      )}
      {text !== '' && <div className="body">{text}</div>}
    </div>
  );
}
