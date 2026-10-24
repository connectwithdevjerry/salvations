/**
 * The studio, wired to this deployment.
 *
 * Pictures and clips are made by the workspace's own OpenAI key, through the
 * same provider port as everything else, and kept in the workspace's own
 * database. Nothing here names a vendor: the port does, and the key decides.
 */
import { providerCredentials } from './platform-ai';
import { providers, keyProvider } from './singletons';
import {
  CredentialRepository, MediaRepository, ModelBindingRepository, findMediaByLink, mediaBytesOf,
  type Database, type MediaDoc,
} from '@salvations/db';
import type { AgentProvider } from '@salvations/core';
import type { StudioSource } from '@salvations/servers';
import { env } from './env';
import { mediaLink } from './media-links';

export interface StudioInput {
  readonly database: Database;
  readonly workspaceId: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly conversationId?: string;
}

export const NO_STUDIO = 'No OpenAI key is connected to this workspace. Pictures and clips need one: add it on the Models page.';

/**
 * A provider that can draw, from the workspace's connected keys.
 *
 * Any enabled provider whose adapter offers images will do; today that is
 * the OpenAI adapter, and the first one found is used.
 */
export async function drawingProvider(database: Database, workspaceId: string): Promise<AgentProvider | undefined> {
  const catalog = new ModelBindingRepository(database, workspaceId);
  const credentials = new CredentialRepository(database, workspaceId, keyProvider());
  const registry = providers();
  for (const row of await catalog.listProviders()) {
    if (!row.enabled) continue;
    if (!registry.has(row.providerType as never)) continue;
    const given = await providerCredentials(credentials, row);
    if (given === undefined) continue;
    const provider = registry.create(row.providerType as never, given);
    if (provider.generateImage !== undefined) return provider;
  }
  return undefined;
}

export const linkFor = (id: string, kind: 'image' | 'video'): string =>
  mediaLink(env().PUBLIC_BASE_URL, env().INTERNAL_HMAC_SECRET, id, kind);

export function createStudioSource(input: StudioInput): StudioSource {
  const media = new MediaRepository(input.database, input.workspaceId);
  const scope = {
    ...(input.agentId !== undefined && input.agentId !== '' ? { agentId: input.agentId } : {}),
    ...(input.runId !== undefined && input.runId !== '' ? { runId: input.runId } : {}),
    ...(input.conversationId !== undefined && input.conversationId !== '' ? { conversationId: input.conversationId } : {}),
  };

  return {
    async createImage(request) {
      const provider = await drawingProvider(input.database, input.workspaceId);
      if (provider?.generateImage === undefined) throw new Error(NO_STUDIO);
      const made = await provider.generateImage({
        prompt: request.prompt, shape: request.shape, ...(request.quality !== undefined ? { quality: request.quality } : {}),
      });
      const row = await media.createReady({ kind: 'image', mimeType: made.mimeType, prompt: request.prompt, bytes: made.bytes, ...scope });
      return { id: row._id, url: linkFor(row._id, 'image') };
    },

    async createVideo(request) {
      const provider = await drawingProvider(input.database, input.workspaceId);
      if (provider?.startVideo === undefined) throw new Error(NO_STUDIO);
      const job = await provider.startVideo({ prompt: request.prompt, seconds: request.seconds, orientation: request.orientation });
      const row = await media.createRendering({
        mimeType: 'video/mp4', prompt: request.prompt,
        job: { providerType: String(provider.providerType), externalId: job.id }, ...scope,
      });
      return { id: row._id, url: linkFor(row._id, 'video'), status: 'rendering' };
    },

    async status(id) {
      const row = await media.findById(id);
      if (row === null) return undefined;
      const settled = row.status === 'rendering' ? await settleRendering(input.database, input.workspaceId, row) : row;
      return {
        id, url: linkFor(id, row.kind), status: settled.status,
        ...(settled.error !== null && settled.error !== undefined ? { error: settled.error } : {}),
      };
    },
  };
}

/**
 * Asks the vendor whether a clip is done and, if it is, keeps it.
 *
 * Returns the row as it now stands. Called by whoever notices a clip is
 * still rendering: the finisher after a run, the check tool, the link.
 */
export async function settleRendering(database: Database, workspaceId: string, row: MediaDoc): Promise<MediaDoc> {
  if (row.status !== 'rendering' || row.job === null || row.job === undefined) return row;
  const media = new MediaRepository(database, workspaceId);
  const provider = await drawingProvider(database, workspaceId);
  if (provider?.videoJob === undefined || provider.videoContent === undefined) return row;
  try {
    const job = await provider.videoJob(row.job.externalId);
    if (job.status === 'completed') {
      const bytes = await provider.videoContent(row.job.externalId);
      await media.markReady(row._id, bytes);
      return { ...row, status: 'ready', bytes: bytes as never, sizeBytes: bytes.byteLength, readyAt: new Date() };
    }
    if (job.status === 'failed') {
      const error = job.error ?? 'The vendor could not render it.';
      await media.markFailed(row._id, error);
      return { ...row, status: 'failed', error };
    }
    return row;
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    await media.markFailed(row._id, error);
    return { ...row, status: 'failed', error };
  }
}

/** A row by its link, with the bytes ready to serve, settling a clip on the way if it is done. */
export async function mediaForLink(database: Database, mediaId: string): Promise<{ row: MediaDoc; bytes?: Uint8Array } | undefined> {
  const row = await findMediaByLink(database, mediaId);
  if (row === null) return undefined;
  const settled = row.status === 'rendering' ? await settleRendering(database, row.workspaceId, row) : row;
  const bytes = mediaBytesOf(settled);
  return bytes === undefined ? { row: settled } : { row: settled, bytes };
}
