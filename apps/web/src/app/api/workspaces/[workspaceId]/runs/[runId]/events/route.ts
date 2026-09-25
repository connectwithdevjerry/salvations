/**
 * Server-sent run events.
 *
 * The browser NEVER connects to the function executing the run. It tails the
 * event log with a `seq` cursor, so:
 *
 *   - a dropped connection resumes exactly where it stopped;
 *   - a refresh replays nothing twice;
 *   - the executor can die mid-answer and the reader sees only a pause.
 *
 * That is the property that makes the Phase 4 worker migration invisible to the
 * frontend: this endpoint reads a collection, and it does not care what wrote
 * to it.
 */
import { STREAM_HEARTBEAT_MS, STREAM_MAX_DURATION_MS, eventStreamQuerySchema } from '@salvations/contracts';
import { isTerminalEvent } from '@salvations/db';
import { eventBus, repositories } from '@/lib/container';
import { db } from '@/lib/db';
import { resolvePrincipal, requirePermission } from '@/lib/principal';
import { errorResponse } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string; runId: string }> },
): Promise<Response> {
  const { workspaceId, runId } = await context.params;

  try {
    const { principal } = await resolvePrincipal(request, workspaceId);
    requirePermission(principal, 'runs:read');

    const handle = await db();
    // Proves the run belongs to this workspace BEFORE opening a stream. The
    // reader filters by workspace too, but a caller should learn "not found"
    // immediately rather than from an empty stream.
    const run = await repositories(handle.db, workspaceId).runs.findById(runId);
    if (run === null) return errorResponse(404, 'not_found', 'Run not found.');

    const query = eventStreamQuerySchema.parse({
      after: new URL(request.url).searchParams.get('after') ?? undefined,
    });

    const { bus, kind } = await eventBus();
    const controller = new AbortController();
    // The client aborting is the normal way a stream ends.
    request.signal.addEventListener('abort', () => controller.abort(), { once: true });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(sink) {
        // Closed by us before any proxy's idle cap, so the client gets a clean
        // end carrying a cursor rather than a dropped socket to guess about.
        const deadline = setTimeout(() => controller.abort(), STREAM_MAX_DURATION_MS);
        const heartbeat = setInterval(() => {
          try { sink.enqueue(encoder.encode(': keep-alive\n\n')); } catch { /* closed */ }
        }, STREAM_HEARTBEAT_MS);

        try {
          sink.enqueue(encoder.encode(`: transport ${kind}\n\n`));

          for await (const event of bus.subscribe(
            runId, workspaceId, query.after, controller.signal,
          )) {
            // `id:` is what the browser's EventSource sends back as
            // Last-Event-ID, so resumption needs no client bookkeeping.
            sink.enqueue(encoder.encode(
              `id: ${event.seq}\nevent: ${event.type}\n` +
              `data: ${JSON.stringify({
                runId: event.runId,
                seq: event.seq,
                type: event.type,
                payload: event.payload,
                createdAt: event.createdAt.toISOString(),
              })}\n\n`,
            ));
            if (isTerminalEvent(event.type)) break;
          }
        } catch {
          // A failed stream is not a failed run. Saying so beats a silent close.
          try {
            sink.enqueue(encoder.encode(
              'event: error\ndata: {"message":"The event stream ended unexpectedly. ' +
              'Reconnect with the last seq you received."}\n\n',
            ));
          } catch { /* already closed */ }
        } finally {
          clearInterval(heartbeat);
          clearTimeout(deadline);
          controller.abort();
          try { sink.close(); } catch { /* already closed */ }
        }
      },
      cancel() { controller.abort(); },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Some proxies buffer streamed responses unless told not to, which
        // turns token streaming into one delivery at the end.
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
