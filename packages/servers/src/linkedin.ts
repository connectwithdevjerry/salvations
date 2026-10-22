/**
 * LinkedIn publishing, as an MCP server.
 *
 * LinkedIn publishes no MCP server, so this is ours over its Posts API: a
 * post as the person, or as a company page they administer, with words, a
 * link, or a picture. The tools close over a source holding the person's
 * grant, so no tool takes a token and no prompt can post as somebody else.
 *
 * Every publishing tool is a write that cannot be repeated, which is what
 * makes policy stop and show the person the exact words first. A clip is
 * uploaded in LinkedIn's parts and then processed on their side; when
 * that takes longer than one call, the model is handed the video's id and
 * finishes the post with it.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'linkedin';
/** LinkedIn's ceiling on a post's commentary. */
export const MAX_POST = 3000;

export interface LinkedInAuthor {
  /** urn:li:person:… or urn:li:organization:… */
  readonly urn: string;
  readonly name: string;
  readonly kind: 'person' | 'organization';
}

export interface LinkedInPost { readonly urn: string; readonly url: string }

/** A clip LinkedIn is still processing: finish the post with `finish_linkedin_post`. */
export interface LinkedInPending { readonly videoUrn: string; readonly status: 'processing' }

export interface LinkedInSource {
  listAuthors(): Promise<readonly LinkedInAuthor[]>;
  publishPost(input: {
    authorUrn: string; text: string; link?: string; linkTitle?: string; imageUrl?: string; videoUrl?: string;
  }): Promise<LinkedInPost | LinkedInPending>;
  finishVideoPost(input: { authorUrn: string; text: string; videoUrn: string }): Promise<LinkedInPost | LinkedInPending>;
}

const isPending = (result: LinkedInPost | LinkedInPending): result is LinkedInPending => 'videoUrn' in result;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

export interface LinkedInOptions { readonly account?: string }

export function createLinkedInServer(_context: ServerContext, source: LinkedInSource, options: LinkedInOptions = {}): McpServer {
  const account = options.account;
  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0', title: account === undefined ? 'LinkedIn' : `LinkedIn (${account})` });
  const d = (value: string): string => (account === undefined ? value : `[${account}] ${value}`);

  server.registerTool('list_authors', {
    title: 'Who this can post as',
    description: d('The person, and any company pages they administer. Call this first for the author id the publishing tool needs.'),
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const authors = await source.listAuthors();
    return text(authors.map((a) => `${a.kind === 'person' ? 'You' : 'Page'}: ${a.name} (author ${a.urn})`).join('\n'));
  });

  const outcome = (result: LinkedInPost | LinkedInPending) => (isPending(result)
    ? text(`LinkedIn is still processing the clip (video ${result.videoUrn}). Call finish_linkedin_post with the same author and text, and that video id, in a moment.`)
    : text(`Published to LinkedIn. ${result.url}`));

  server.registerTool('publish_linkedin_post', {
    title: 'Publish a LinkedIn post',
    description: d(
      'Post now, as the person or a page: the words, with a link, a picture (a public https jpeg or png) or a '
      + 'clip (a public https mp4), such as one the studio made. A clip may take a minute to process; if the '
      + 'answer says so, call finish_linkedin_post. This publishes for real; it cannot be taken back from here.',
    ),
    inputSchema: {
      author: z.string().trim().min(1).max(80).describe('From list_authors.'),
      text: z.string().trim().min(1).max(MAX_POST).describe('The post. Hashtags count; line breaks are kept.'),
      link: z.string().url().optional().describe('A link to share with the post.'),
      link_title: z.string().trim().max(200).optional(),
      image_url: z.string().url().optional().describe('A public https picture to attach.'),
      video_url: z.string().url().optional().describe('A public https mp4 to attach.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args) => {
    const attachments = [args.link, args.image_url, args.video_url].filter((v) => v !== undefined).length;
    if (attachments > 1) {
      return { content: [{ type: 'text' as const, text: 'One of a link, a picture or a clip, not more.' }], isError: true };
    }
    const posted = await source.publishPost({
      authorUrn: args.author, text: args.text,
      ...(args.link !== undefined ? { link: args.link } : {}),
      ...(args.link_title !== undefined ? { linkTitle: args.link_title } : {}),
      ...(args.image_url !== undefined ? { imageUrl: args.image_url } : {}),
      ...(args.video_url !== undefined ? { videoUrl: args.video_url } : {}),
    });
    return outcome(posted);
  });

  server.registerTool('finish_linkedin_post', {
    title: 'Finish a LinkedIn post with a clip',
    description: d('Publishes the post whose clip LinkedIn was still processing when publish_linkedin_post was called.'),
    inputSchema: {
      author: z.string().trim().min(1).max(80),
      text: z.string().trim().min(1).max(MAX_POST),
      video: z.string().trim().min(1).max(120).describe('The video id from the earlier answer.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args) => outcome(await source.finishVideoPost({ authorUrn: args.author, text: args.text, videoUrn: args.video })));

  return server;
}
