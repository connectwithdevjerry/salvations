'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Watching a run.
 *
 * `EventSource` handles reconnection and replays `Last-Event-ID` for us, which
 * is the whole reason the server writes the event seq into the SSE `id:` field:
 * a dropped connection resumes exactly where it stopped, with no bookkeeping
 * here.
 *
 * The one thing it does NOT do is stop. A finished run would be reconnected to
 * forever, so this closes the connection itself on a terminal event.
 */
export interface StreamedToolCall {
  readonly id: string;
  readonly name: string;
  readonly isError?: boolean;
  readonly finished: boolean;
}

export interface RunStreamState {
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: readonly StreamedToolCall[];
  readonly status: 'connecting' | 'streaming' | 'suspended' | 'finished' | 'error';
  readonly suspension?: { reason: string; approvalId?: string };
  readonly finish?: { reason?: string; message?: string };
  readonly lastSeq: number;
}

const EMPTY: RunStreamState = {
  text: '', reasoning: '', toolCalls: [], status: 'connecting', lastSeq: -1,
};

const TERMINAL = new Set(['run_finished', 'run_suspended', 'run_yielded']);

export function useRunStream(
  workspaceId: string,
  runId: string | undefined,
  onTerminal?: () => void,
): RunStreamState & { reset: () => void } {
  const [state, setState] = useState<RunStreamState>(EMPTY);
  const terminalRef = useRef(onTerminal);
  terminalRef.current = onTerminal;

  const reset = useCallback(() => setState(EMPTY), []);

  useEffect(() => {
    if (runId === undefined) return;
    setState(EMPTY);

    const source = new EventSource(
      `/api/workspaces/${workspaceId}/runs/${runId}/events?after=-1`,
    );

    const handle = (type: string) => (raw: MessageEvent<string>) => {
      let event: { seq: number; payload: Record<string, unknown> };
      try {
        event = JSON.parse(raw.data) as typeof event;
      } catch {
        // A malformed frame is not worth tearing the stream down for; the next
        // one carries a higher seq and the run continues.
        return;
      }

      setState((current) => next(current, type, event));

      if (TERMINAL.has(type)) {
        source.close();
        terminalRef.current?.();
      }
    };

    for (const type of [
      'text_delta', 'reasoning_delta', 'tool_call_started', 'tool_call_finished',
      'step_started', 'approval_requested', 'run_suspended', 'run_yielded', 'run_finished',
      'error',
    ]) {
      source.addEventListener(type, handle(type) as EventListener);
    }

    source.onerror = () => {
      // EventSource reconnects on its own; this only surfaces the gap so the UI
      // can say something rather than appearing frozen.
      setState((current) =>
        current.status === 'finished' || current.status === 'suspended'
          ? current
          : { ...current, status: 'error' });
    };

    return () => source.close();
  }, [workspaceId, runId]);

  return { ...state, reset };
}

function next(
  current: RunStreamState,
  type: string,
  event: { seq: number; payload: Record<string, unknown> },
): RunStreamState {
  // Out-of-order or replayed frames are ignored rather than appended: appending
  // a duplicate delta would corrupt the answer in a way nothing later corrects.
  if (event.seq <= current.lastSeq) return current;
  const base = { ...current, lastSeq: event.seq, status: 'streaming' as const };

  switch (type) {
    case 'text_delta':
      return { ...base, text: current.text + String(event.payload['text'] ?? '') };

    case 'reasoning_delta':
      return { ...base, reasoning: current.reasoning + String(event.payload['text'] ?? '') };

    case 'tool_call_started':
      return {
        ...base,
        toolCalls: [...current.toolCalls, {
          id: String(event.payload['id'] ?? ''),
          name: String(event.payload['name'] ?? 'tool'),
          finished: false,
        }],
      };

    case 'tool_call_finished':
      return {
        ...base,
        toolCalls: current.toolCalls.map((call) =>
          call.id === event.payload['id']
            ? { ...call, finished: true, isError: event.payload['isError'] === true }
            : call),
      };

    case 'run_suspended':
      return {
        ...base,
        status: 'suspended',
        suspension: {
          reason: String(event.payload['reason'] ?? 'approval'),
          ...(typeof event.payload['approvalId'] === 'string'
            ? { approvalId: event.payload['approvalId'] }
            : {}),
        },
      };

    case 'run_finished':
    case 'run_yielded':
      return {
        ...base,
        status: 'finished',
        finish: {
          ...(typeof event.payload['reason'] === 'string'
            ? { reason: event.payload['reason'] }
            : {}),
          ...(typeof event.payload['message'] === 'string'
            ? { message: event.payload['message'] }
            : {}),
        },
      };

    case 'error':
      return { ...base, status: 'error' };

    default:
      return base;
  }
}
