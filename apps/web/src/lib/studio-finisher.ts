/**
 * Clips that outlive the run that started them.
 *
 * On its own rather than in the studio service, because this is the one
 * place the studio meets the chat: the service makes things, the delivery
 * sends things, and a module that did both would be a cycle.
 */
import { MediaRepository, PlatformDb, type RunDoc } from '@salvations/db';
import { db } from './db';
import { channelTargetOf, isTarget } from './channel-delivery';
import { linkFor, settleRendering } from './studio-service';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Waits for the clips a run started, and sends each to the chat as it lands.
 *
 * Runs after the answer is delivered, in the time the function has left: a
 * clip takes minutes and the answer must not. Whatever is still rendering at
 * the deadline is finished by the next thing that looks at it, the link or
 * the check tool.
 */
export async function finishRenderingForRun(runId: string, untilMs: number): Promise<void> {
  const handle = await db();
  const platform = new PlatformDb(handle.db, 'channel-delivery');
  const run = await platform.collection<RunDoc>('runs').findOne({ _id: runId } as never, { comment: platform.comment });
  if (run === null) return;
  const media = new MediaRepository(handle.db, run.workspaceId);
  let pending = await media.renderingForRun(runId);
  if (pending.length === 0) return;

  const target = await channelTargetOf(runId);
  while (pending.length > 0 && Date.now() < untilMs) {
    for (const row of pending) {
      const settled = await settleRendering(handle.db, run.workspaceId, row);
      if (settled.status === 'ready' && isTarget(target) && target.adapter.sendMedia !== undefined) {
        await target.adapter.sendMedia(target.token, target.chatRef, {
          kind: 'video', url: linkFor(row._id, 'video'), caption: 'Your clip is ready.',
        }).catch(() => undefined);
      }
    }
    pending = await media.renderingForRun(runId);
    if (pending.length === 0) break;
    await sleep(Math.min(10_000, Math.max(0, untilMs - Date.now())));
  }
}
