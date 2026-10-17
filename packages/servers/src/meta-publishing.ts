/**
 * Instagram and Facebook publishing, as an MCP server.
 *
 * Meta publishes no MCP server for the Graph API, so this is ours, built
 * like the other first-party servers: the tools close over a source that
 * already holds the person's grant, so no tool takes a token and no prompt
 * can post as somebody else.
 *
 * Posting is the whole point and the whole risk: every publishing tool is
 * marked as a write that is not idempotent, which is what makes the policy
 * layer stop and show the person the exact caption and picture first. A
 * post cannot be unposted by this server; `destructiveHint` stays false
 * because nothing here deletes, but nothing here is undone either.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'meta_publishing';
/** Instagram's ceiling on a caption; Facebook's is far higher and not worth reaching. */
export const MAX_CAPTION = 2200;

export interface SocialAccount {
  readonly pageId: string;
  readonly pageName: string;
  /** The Instagram professional account linked to the page, when there is one. */
  readonly instagram?: { readonly id: string; readonly username: string };
}

export interface PublishedPost {
  readonly id: string;
  readonly url?: string;
}

/** A clip Instagram is still processing: finish it with `finish_instagram_post`. */
export interface PendingPost {
  readonly creationId: string;
  readonly status: 'processing';
}

/** What the server needs from Meta, with the person's grant already in hand. */
export interface MetaPublishingSource {
  listAccounts(): Promise<readonly SocialAccount[]>;
  publishFacebookPost(input: {
    pageId: string; message: string; link?: string; imageUrl?: string; videoUrl?: string;
  }): Promise<PublishedPost>;
  publishInstagramPost(input: {
    instagramId: string; caption: string; imageUrl?: string; videoUrl?: string;
  }): Promise<PublishedPost | PendingPost>;
  finishInstagramPost(instagramId: string, creationId: string): Promise<PublishedPost | PendingPost>;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (value: string) => ({ content: [{ type: 'text' as const, text: value }], isError: true });

const isPending = (result: PublishedPost | PendingPost): result is PendingPost => 'creationId' in result;

const accountLine = (a: SocialAccount): string =>
  `Facebook page "${a.pageName}" (page id ${a.pageId})`
  + (a.instagram === undefined ? ', no Instagram account linked' : `, Instagram @${a.instagram.username} (instagram id ${a.instagram.id})`);

export interface MetaPublishingOptions {
  /** The account's name when the app is connected more than once. */
  readonly account?: string;
}

export function createMetaPublishingServer(
  _context: ServerContext,
  source: MetaPublishingSource,
  options: MetaPublishingOptions = {},
): McpServer {
  const account = options.account;
  const server = new McpServer({
    name: SERVER_NAME, version: '1.0.0',
    title: account === undefined ? 'Instagram & Facebook' : `Instagram & Facebook (${account})`,
  });
  const d = (value: string): string => (account === undefined ? value : `[${account}] ${value}`);

  server.registerTool(
    'list_accounts',
    {
      title: 'List pages and Instagram accounts',
      description: d(
        'The Facebook pages this connection can post to, and the Instagram account linked to '
        + 'each. Call this first to get the page id or instagram id the publishing tools need.',
      ),
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const accounts = await source.listAccounts();
      if (accounts.length === 0) return text('This connection has no Facebook pages. The person needs to be an admin of a page, and to tick it on the consent screen.');
      return text(accounts.map(accountLine).join('\n'));
    },
  );

  server.registerTool(
    'publish_facebook_post',
    {
      title: 'Publish to a Facebook page',
      description: d(
        'Post to a Facebook page now: the message, with a link, a picture or a clip. Use a '
        + 'picture or clip link the studio made, or any public https link. This publishes for '
        + 'real; it cannot be taken back from here.',
      ),
      inputSchema: {
        page_id: z.string().trim().min(1).max(40).describe('From list_accounts.'),
        message: z.string().trim().min(1).max(MAX_CAPTION).describe('The post text, hashtags included.'),
        link: z.string().url().optional().describe('A link to share with the post.'),
        image_url: z.string().url().optional().describe('A public https picture to post.'),
        video_url: z.string().url().optional().describe('A public https clip (mp4) to post.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (args.image_url !== undefined && args.video_url !== undefined) return failure('One of a picture or a clip, not both.');
      const posted = await source.publishFacebookPost({
        pageId: args.page_id, message: args.message,
        ...(args.link !== undefined ? { link: args.link } : {}),
        ...(args.image_url !== undefined ? { imageUrl: args.image_url } : {}),
        ...(args.video_url !== undefined ? { videoUrl: args.video_url } : {}),
      });
      return text(`Published to Facebook (post ${posted.id}).${posted.url !== undefined ? ` ${posted.url}` : ''}`);
    },
  );

  server.registerTool(
    'publish_instagram_post',
    {
      title: 'Publish to Instagram',
      description: d(
        'Post to an Instagram professional account now: a picture with a caption, or a clip as '
        + 'a reel. Instagram needs a picture or a clip; there are no text-only posts. Use a link '
        + 'the studio made, or any public https link (jpeg for pictures, mp4 for clips). A reel '
        + 'may take a minute to process; if the answer says so, call finish_instagram_post.',
      ),
      inputSchema: {
        instagram_id: z.string().trim().min(1).max(40).describe('From list_accounts.'),
        caption: z.string().trim().min(1).max(MAX_CAPTION).describe('The caption, hashtags included.'),
        image_url: z.string().url().optional().describe('A public https jpeg to post.'),
        video_url: z.string().url().optional().describe('A public https mp4 to post as a reel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (args.image_url === undefined && args.video_url === undefined) return failure('Instagram needs a picture or a clip. Make one with the studio first.');
      if (args.image_url !== undefined && args.video_url !== undefined) return failure('One of a picture or a clip, not both.');
      const result = await source.publishInstagramPost({
        instagramId: args.instagram_id, caption: args.caption,
        ...(args.image_url !== undefined ? { imageUrl: args.image_url } : {}),
        ...(args.video_url !== undefined ? { videoUrl: args.video_url } : {}),
      });
      if (isPending(result)) {
        return text(`Instagram is still processing the clip (creation id ${result.creationId}). Call finish_instagram_post with that id in a moment to publish it.`);
      }
      return text(`Published to Instagram (post ${result.id}).${result.url !== undefined ? ` ${result.url}` : ''}`);
    },
  );

  server.registerTool(
    'finish_instagram_post',
    {
      title: 'Finish an Instagram post',
      description: d('Publishes a clip Instagram was still processing when publish_instagram_post was called.'),
      inputSchema: {
        instagram_id: z.string().trim().min(1).max(40),
        creation_id: z.string().trim().min(1).max(60).describe('From the earlier answer.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const result = await source.finishInstagramPost(args.instagram_id, args.creation_id);
      if (isPending(result)) return text(`Still processing (creation id ${result.creationId}). Try again in a moment.`);
      return text(`Published to Instagram (post ${result.id}).${result.url !== undefined ? ` ${result.url}` : ''}`);
    },
  );

  return server;
}
