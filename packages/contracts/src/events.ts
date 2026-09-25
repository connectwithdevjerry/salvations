/**
 * Run events, as they reach a browser.
 *
 * The transport is SSE with a `seq` cursor, so a dropped connection resumes
 * from where it stopped rather than replaying a conversation or losing the
 * middle of an answer. That is only true because `seq` is dense and assigned by
 * the writer, never by the reader.
 */
import { z } from 'zod';
import { idSchema, runStatusSchema, usageSchema } from './common';

export const runEventTypeSchema = z.enum([
  'run_started',
  'step_started',
  'text_delta',
  'reasoning_delta',
  'tool_call_started',
  'tool_call_finished',
  'approval_requested',
  'run_suspended',
  'run_yielded',
  'run_finished',
  'error',
]);

export const runEventSchema = z.object({
  runId: idSchema,
  seq: z.number().int().min(0),
  type: runEventTypeSchema,
  payload: z.unknown(),
  createdAt: z.string(),
});

export type RunEventDto = z.infer<typeof runEventSchema>;

/**
 * Payloads, by event type.
 *
 * Declared rather than left as `unknown` so the UI can narrow. Kept permissive
 * on read (`.passthrough()` semantics via optional fields) because a client
 * running older code must not break on a field added by a newer server.
 */
export const textDeltaPayload = z.object({ text: z.string() });
export const toolCallStartedPayload = z.object({ id: z.string(), name: z.string() });
export const toolCallFinishedPayload = z.object({
  id: z.string(), name: z.string(), isError: z.boolean(), durationMs: z.number().optional(),
});
export const stepStartedPayload = z.object({
  seq: z.number(), type: z.string(), prefixFingerprint: z.string().optional(),
});
export const approvalRequestedPayload = z.object({
  approvalId: idSchema, reason: z.string().optional(),
});
export const runSuspendedPayload = z.object({
  reason: z.enum(['approval', 'input', 'tool']), approvalId: idSchema.optional(),
});
export const runFinishedPayload = z.object({
  status: runStatusSchema.optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  usage: usageSchema.optional(),
});

/** The query a client uses to resume. */
export const eventStreamQuerySchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
});

/**
 * How long a stream stays open before asking the client to reconnect.
 *
 * Shorter than any platform or proxy idle cap, so the close is ours and
 * carries a cursor rather than arriving as a dropped socket the client has to
 * guess about.
 */
export const STREAM_MAX_DURATION_MS = 4 * 60 * 1000;

/** Keeps intermediaries from closing an idle connection. */
export const STREAM_HEARTBEAT_MS = 15_000;
