'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ws } from '@/lib/client/api';
import { useRunStream } from '@/lib/client/use-run-stream';
import { ApprovalPrompt } from '@/components/approval-prompt';
import { Icon, Tile } from '@/components/ui';
import { AgentAvatar } from '@/components/agent-avatar';
import { RichText } from '@/components/rich-text';

interface Block { type: string; text?: string; name?: string; isError?: boolean }
interface Message {
  id: string; seq: number; role: string; content: Block[]; runId?: string; createdAt: string;
}
interface ModelBinding { id: string; name: string; providerType: string; modelId: string }
interface LastRun { id: string; status: string; error?: { code: string; message: string }; finishedAt?: string }

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
  workspaceId, agentId, agent, conversationId, onCreated,
}: {
  workspaceId: string;
  agentId: string;
  /** For the avatar beside its turns. Absent, a neutral one is drawn. */
  agent?: { name: string; color: string };
  conversationId: string | undefined;
  onCreated?: (conversationId: string) => void;
}) {
  const base = conversationId === undefined ? undefined : `${ws(workspaceId)}/conversations/${conversationId}`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<ModelBinding[]>([]);
  const [modelBindingId, setModelBindingId] = useState('');
  // Set only by the dropdown. The assistant's own choice (its Model tab) wins
  // otherwise, so changing it there moves this conversation too.
  const [picked, setPicked] = useState<string>();
  const [draft, setDraft] = useState('');
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState<string>();
  const [lastRun, setLastRun] = useState<LastRun>();
  const logRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    if (base === undefined) {
      setMessages([]);
      return;
    }
    const result = await api.get<{
      conversation: { modelBindingId: string }; items: Message[]; lastRun?: LastRun;
    }>(`${base}/messages`);
    setMessages(result.items);
    setModelBindingId(result.conversation.modelBindingId);
    setLastRun(result.lastRun);
  }, [base]);

  useEffect(() => {
    setRunId(undefined);
    setError(undefined);
    setPicked(undefined);
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
        ...(picked !== undefined ? { modelBindingId: picked } : {}),
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
  const who = { name: agent?.name ?? 'Assistant', color: agent?.color ?? '#3b82f6' };
  const turns = fold(messages);

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef}>
        <div className="thread">
          {messages.length === 0 && runId === undefined && (
            <EmptyState onPick={(text) => void submit(text)} />
          )}

          {turns.map((turn) => (
            <Turn key={turn.id} turn={turn} who={who} workspaceId={workspaceId} />
          ))}

          {runId === undefined && lastRun?.status === 'failed' && (
            <RunFailure run={lastRun} workspaceId={workspaceId} />
          )}

          {runId !== undefined && (
            <div className="turn assistant live">
              <AgentAvatar color={who.color} size={30} />
              <div className="turn-body">
                {stream.toolCalls.length > 0 && (
                  <div className="turn-tools">
                    {stream.toolCalls.map((call) => (
                      <span key={call.id} className={`tool-chip${call.isError === true ? ' err' : ''}`}>
                        {call.finished ? (call.isError === true ? '✕' : '✓') : <span className="tool-spin" />}
                        {pretty(call.name)}
                      </span>
                    ))}
                  </div>
                )}
                <div className="bubble">
                  {stream.text === '' && stream.status !== 'error'
                    ? <span className="typing" aria-label="Thinking"><i /><i /><i /></span>
                    : <RichText text={stream.text} />}
                  {stream.status === 'streaming' && stream.text !== '' && <span className="caret" aria-hidden />}
                </div>
                {stream.status === 'error' && (
                  <p className="turn-note">Connection interrupted — reconnecting.</p>
                )}
                {stream.suspension?.approvalId !== undefined && (
                  <ApprovalPrompt
                    workspaceId={workspaceId}
                    approvalId={stream.suspension.approvalId}
                    onDecided={() => { void reload(); setRunId(undefined); }}
                  />
                )}
                {stream.finish?.message !== undefined && (
                  <p className="turn-note">Stopped: {stream.finish.message}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="chat-form">
        <div className="composer">
          {error !== undefined && <p className="error" style={{ margin: '0 0 8px' }}>{error}</p>}
          <form onSubmit={send}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={busy ? `${who.name} is working…` : `Message ${who.name}`}
              disabled={busy}
              rows={1}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(e);
                }
              }}
            />
            <button
              className="send" type="submit" disabled={busy || draft.trim() === ''}
              aria-label="Send"
            >
              <Icon name="arrow" size={17} />
            </button>
          </form>
          <div className="composer-foot">
            <label>
              <span className="faint">Model</span>
              <select
                value={modelBindingId}
                onChange={(e) => { setModelBindingId(e.target.value); setPicked(e.target.value); }}
                disabled={busy}
              >
                {modelBindingId === '' && <option value="">Assistant&apos;s default</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} · {m.modelId}</option>
                ))}
              </select>
            </label>
            <span className="faint">Enter to send · Shift+Enter for a new line</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A turn as it is shown, which is not quite a message as it is stored.
 *
 * Tool results are their own messages in the record — that is what makes a
 * run replayable — but nobody reading a conversation wants a row saying "2
 * tool results" between two sentences. They are folded into the assistant
 * turn that asked for them, as a count.
 */
interface ShownTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  tools: string[];
  toolResults: { count: number; failed: number };
  runId?: string;
  createdAt: string;
}

function fold(messages: readonly Message[]): ShownTurn[] {
  const out: ShownTurn[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const previous = out[out.length - 1];
      if (previous !== undefined && previous.role === 'assistant') {
        previous.toolResults.count += m.content.length;
        previous.toolResults.failed += m.content.filter((b) => b.isError === true).length;
      }
      continue;
    }
    const text = textOf(m.content);
    const tools = m.content.filter((b) => b.type === 'tool_use').map((b) => b.name ?? 'tool');
    const previous = out[out.length - 1];

    // Consecutive assistant messages from one run are one answer: the model
    // asked for tools, got them, then spoke. Shown as one turn, tools above.
    if (m.role === 'assistant' && previous?.role === 'assistant' && previous.runId !== undefined && previous.runId === m.runId) {
      previous.tools.push(...tools);
      previous.text = previous.text === '' ? text : text === '' ? previous.text : `${previous.text}\n\n${text}`;
      previous.createdAt = m.createdAt;
      continue;
    }

    out.push({
      id: m.id,
      role: m.role as ShownTurn['role'],
      text,
      tools,
      toolResults: { count: 0, failed: 0 },
      ...(m.runId !== undefined ? { runId: m.runId } : {}),
      createdAt: m.createdAt,
    });
  }
  return out;
}

function Turn({ turn, who, workspaceId }: { turn: ShownTurn; who: { name: string; color: string }; workspaceId: string }) {
  if (turn.role === 'system') {
    return (
      <div className="turn system">
        <span className="turn-system">Earlier conversation summarised</span>
      </div>
    );
  }

  if (turn.role === 'user') {
    return (
      <div className="turn user">
        <div className="turn-body">
          <div className="bubble"><RichText text={turn.text} /></div>
          <span className="turn-time">{clock(turn.createdAt)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="turn assistant">
      <AgentAvatar color={who.color} size={30} />
      <div className="turn-body">
        {turn.tools.length > 0 && (
          <div className="turn-tools">
            {turn.tools.map((name, i) => <span key={i} className="tool-chip">✓ {pretty(name)}</span>)}
            {turn.toolResults.failed > 0 && (
              <span className="tool-chip err">{turn.toolResults.failed} failed</span>
            )}
          </div>
        )}
        {turn.text !== '' && <div className="bubble"><RichText text={turn.text} /></div>}
        <span className="turn-time">
          {clock(turn.createdAt)}
          {turn.runId !== undefined && (
            <> · <Link href={`/w/${workspaceId}/runs/${turn.runId}`}>run</Link></>
          )}
        </span>
      </div>
    </div>
  );
}

/** `github__list_issues` → `github · list issues`. */
const pretty = (name: string): string => name.replace('__', ' · ').replace(/_/g, ' ');

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

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

/**
 * A reply that did not come, with the reason, kept on the page.
 *
 * The live stream shows a failure for a second and is then replaced by the
 * persisted thread, which has no failure in it. This reads the run record
 * instead, so the vendor's own words stay in front of the person until the
 * next reply lands, and the common ones come with the thing to do about it.
 */
function RunFailure({ run, workspaceId }: { run: LastRun; workspaceId: string }) {
  const message = tidy(run.error?.message ?? 'The reply failed.');
  const link = /401|invalid api key|authentication|incorrect api key|model binding|no model/i.test(message)
    ? { text: 'Open Models', href: `/w/${workspaceId}/models` }
    : undefined;
  return (
    <div className="run-failure" role="alert">
      <span className="run-failure-mark" aria-hidden>!</span>
      <span className="run-failure-message">
        {message}
        {link !== undefined && <>{' '}<a href={link.href}>{link.text}</a></>}
      </span>
    </div>
  );
}

/** A message that is already a sentence stays; one that is a dump becomes one. */
function tidy(raw: string): string {
  const body = raw.replace(/^\d{3}\s+/, '');
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; error?: { message?: string } }; message?: string };
    const inner = parsed.error?.error?.message ?? parsed.error?.message ?? parsed.message;
    if (typeof inner === 'string' && inner !== '') return inner;
  } catch { /* plain text */ }
  return body;
}
