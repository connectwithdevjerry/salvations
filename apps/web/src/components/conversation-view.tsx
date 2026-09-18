'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ws } from '@/lib/client/api';
import { useRunStream } from '@/lib/client/use-run-stream';
import { ApprovalPrompt } from '@/components/approval-prompt';
import { Tile } from '@/components/ui';

interface Block { type: string; text?: string; name?: string; isError?: boolean }
interface Message {
  id: string; seq: number; role: string; content: Block[]; runId?: string; createdAt: string;
}
interface ModelBinding { id: string; name: string; providerType: string; modelId: string }

const textOf = (content: Block[]): string =>
  content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

/**
 * One conversation with one assistant.
 *
 * `conversationId` may be absent: a fresh "New chat" is not a row until
 * something is said in it, so the first send creates the conversation and
 * reports its id. That keeps the list free of empty chats somebody opened and
 * walked away from.
 */
export function ConversationView({
  workspaceId, agentId, conversationId, onCreated,
}: {
  workspaceId: string;
  agentId: string;
  conversationId: string | undefined;
  onCreated?: (conversationId: string) => void;
}) {
  const base = conversationId === undefined ? undefined : `${ws(workspaceId)}/conversations/${conversationId}`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<ModelBinding[]>([]);
  const [modelBindingId, setModelBindingId] = useState('');
  const [draft, setDraft] = useState('');
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState<string>();
  const logRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    if (base === undefined) {
      setMessages([]);
      return;
    }
    const result = await api.get<{
      conversation: { modelBindingId: string }; items: Message[];
    }>(`${base}/messages`);
    setMessages(result.items);
    setModelBindingId(result.conversation.modelBindingId);
  }, [base]);

  useEffect(() => {
    setRunId(undefined);
    setError(undefined);
    void reload().catch((e: Error) => setError(e.message));
  }, [reload]);

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
    await submit(draft);
  }

  /**
   * Sends one turn.
   *
   * Takes the text rather than reading the draft, because a starter prompt is
   * sent without ever being typed and a version that only knew about the
   * textarea would have to fake a keystroke to do it.
   */
  async function submit(text: string) {
    const content = text.trim();
    if (content === '' || runId !== undefined) return;

    setDraft('');
    setError(undefined);
    try {
      let target = base;
      if (target === undefined) {
        // The first message makes the conversation real.
        const created = await api.post<{ id: string; modelBindingId: string }>(
          `${ws(workspaceId)}/conversations`, { agentId },
        );
        target = `${ws(workspaceId)}/conversations/${created.id}`;
        setModelBindingId(created.modelBindingId);
        onCreated?.(created.id);
      }
      const result = await api.post<{ runId: string }>(`${target}/messages`, {
        content,
        ...(modelBindingId !== '' ? { modelBindingId } : {}),
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
        <div className="row" style={{ marginBottom: 16, justifyContent: 'flex-end' }}>
          <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="muted">Model</span>
            <select
              value={modelBindingId}
              onChange={(e) => setModelBindingId(e.target.value)}
              disabled={busy}
              style={{ width: 'auto' }}
            >
              {modelBindingId === '' && <option value="">Assistant&apos;s default</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name} · {m.modelId}</option>
              ))}
            </select>
          </label>
        </div>

        {messages.length === 0 && runId === undefined && (
          <EmptyState onPick={(text) => void submit(text)} />
        )}

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

/**
 * What an empty conversation says.
 *
 * The prompts are deliberately about what this agent can be asked rather than
 * what it can do: a new conversation cannot know which tools are bound, and a
 * suggestion that turns out to be impossible is worse than no suggestion.
 */
const STARTERS = [
  'What can you do?',
  'What tools do you have?',
  'Help me get started',
] as const;

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div style={{ maxWidth: 620, margin: '56px auto 0', textAlign: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
        <Tile name="chat" large />
      </div>
      <h3 style={{ margin: '0 0 6px', fontSize: 18 }}>Nothing here yet</h3>
      <p className="muted" style={{ margin: '0 0 20px' }}>
        Give it something small first. Anything it does that writes, sends or spends stops for
        your approval.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        {STARTERS.map((starter) => (
          <button key={starter} type="button" onClick={() => onPick(starter)}>
            {starter}
          </button>
        ))}
      </div>
    </div>
  );
}
