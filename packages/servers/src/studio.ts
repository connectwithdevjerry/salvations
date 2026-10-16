/**
 * The studio: pictures and clips from words.
 *
 * Built like the other first-party servers: the tools close over a source
 * that already knows whose workspace this is and whose key pays for the
 * render. A picture comes back as a link the chat can show; a clip takes
 * minutes, so it comes back as a link that fills in when the render is done.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'studio';
export const MAX_PROMPT = 4_000;

export type MediaShape = 'square' | 'portrait' | 'landscape';

export interface StudioSource {
  createImage(input: { prompt: string; shape: MediaShape; quality?: 'standard' | 'high' }): Promise<{ id: string; url: string }>;
  createVideo(input: { prompt: string; seconds: 4 | 8 | 12; orientation: 'portrait' | 'landscape' }): Promise<{ id: string; url: string; status: 'rendering' | 'ready' }>;
  /** Where a clip has got to. Checks with the vendor when it is still rendering. */
  status(id: string): Promise<{ id: string; url: string; status: 'rendering' | 'ready' | 'failed'; error?: string } | undefined>;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (value: string) => ({ content: [{ type: 'text' as const, text: value }], isError: true });

export function createStudioServer(_context: ServerContext, source: StudioSource): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0', title: 'Studio' });

  server.registerTool(
    'create_image',
    {
      title: 'Create a picture',
      description:
        'Make a picture from a description: a product shot, a dish, a poster, a social post '
        + 'image. Describe the subject, the setting, the light and the mood in plain words; name '
        + 'the brand colours if you know them. Returns a link. Put the link on its own line in your '
        + 'reply so it is shown as a picture. One strong image is usually enough; make more only '
        + 'when asked.',
      inputSchema: {
        prompt: z.string().trim().min(1).max(MAX_PROMPT).describe('What the picture shows, in detail.'),
        shape: z.enum(['square', 'portrait', 'landscape']).default('square')
          .describe('square for feeds, portrait for stories and reels, landscape for banners.'),
        quality: z.enum(['standard', 'high']).default('standard'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const made = await source.createImage({ prompt: args.prompt, shape: args.shape, quality: args.quality });
        return text(`Picture ready (id ${made.id}). Show it by putting this link on its own line:\n${made.url}`);
      } catch (caught) {
        return failure(caught instanceof Error ? caught.message : 'The picture could not be made.');
      }
    },
  );

  server.registerTool(
    'create_video',
    {
      title: 'Create a short clip',
      description:
        'Make a short clip from a description: a product turning, a dish being plated, a '
        + 'few seconds of mood for a reel. Rendering takes a few minutes, so this returns at '
        + 'once with a link that fills in when the clip is done; the chat is sent the clip '
        + 'then. Put the link on its own line in your reply. Use it when movement sells the '
        + 'thing or the platform wants video, not for every post.',
      inputSchema: {
        prompt: z.string().trim().min(1).max(MAX_PROMPT).describe('What happens in the clip, shot by shot if you like.'),
        seconds: z.union([z.literal(4), z.literal(8), z.literal(12)]).default(8),
        orientation: z.enum(['portrait', 'landscape']).default('portrait')
          .describe('portrait for reels, stories and TikTok; landscape for YouTube and sites.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const made = await source.createVideo({ prompt: args.prompt, seconds: args.seconds, orientation: args.orientation });
        return text(made.status === 'ready'
          ? `Clip ready (id ${made.id}). Show it by putting this link on its own line:\n${made.url}`
          : `Clip is rendering (id ${made.id}); it takes a few minutes and will be sent to the chat when done. Put this link on its own line in your reply:\n${made.url}`);
      } catch (caught) {
        return failure(caught instanceof Error ? caught.message : 'The clip could not be started.');
      }
    },
  );

  server.registerTool(
    'check_video',
    {
      title: 'Check a clip',
      description: 'Whether a clip started with create_video is done. Use it when asked whether the video is ready.',
      inputSchema: { id: z.string().trim().min(1).max(64) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const found = await source.status(args.id);
      if (found === undefined) return failure('No clip with that id.');
      if (found.status === 'ready') return text(`Ready. Link:\n${found.url}`);
      if (found.status === 'failed') return failure(`The render failed: ${found.error ?? 'no reason given'}. Try create_video again with a simpler description.`);
      return text('Still rendering. It is sent to the chat the moment it is done.');
    },
  );

  return server;
}
