/**
 * The web server: reading a page.
 *
 * An assistant asked about a link, a price on a site or something that
 * happened this week has nowhere to look without this. It fetches one page
 * at a time and hands back the words on it, not the markup: a model reading
 * raw HTML pays for every tag and understands less.
 *
 * Read-only by construction, and the fetcher behind it decides what may be
 * reached: only public web addresses, never anything inside the network the
 * deployment runs in. That decision lives in the source, not here, so it is
 * made once and cannot be argued with through a tool argument.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'web';

/** Most characters of text one read returns. Beyond this the page is offered in further parts. */
export const MAX_CHARS = 12_000;
/** Most links listed after the text, so a page of a thousand links does not become one. */
export const MAX_LINKS = 40;

export interface FetchedPage {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** Most results one search returns. */
export const MAX_SEARCH = 10;

export interface WebSource {
  /** Fetches the address, following redirects. Throws with a plain sentence when it cannot. */
  fetch(url: string): Promise<FetchedPage>;
  /**
   * Searches the web. Absent when the deployment has no search engine
   * configured, in which case no search tool is offered at all: a tool that
   * always fails teaches a model to stop trying.
   */
  search?(query: string, count: number): Promise<readonly SearchResult[]>;
}

export function createWebServer(context: ServerContext, source: WebSource): McpServer {
  void context;
  const server = new McpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    title: 'The web',
  });

  server.registerTool(
    'read_page',
    {
      title: 'Read a web page',
      description:
        'Fetch a public web page and read what it says, as plain text with its links '
        + 'listed after. Use it when someone sends a link, asks about a company, a '
        + 'product or a price on a site, or asks about anything recent. Long pages '
        + 'come in parts: read the next part with `from`. It cannot search the web; '
        + 'it needs an address to start from.',
      inputSchema: {
        url: z.string().trim().url().max(2_000).describe('The address, with http:// or https://.'),
        from: z.number().int().min(0).default(0)
          .describe('Character offset to continue from, for a page longer than one read.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      let page: FetchedPage;
      try {
        page = await source.fetch(args.url);
      } catch (caught) {
        return {
          content: [{ type: 'text' as const, text: caught instanceof Error ? caught.message : 'That page could not be read.' }],
          isError: true,
        };
      }

      const extracted = extract(page);
      const from = Math.min(args.from ?? 0, extracted.text.length);
      const slice = extracted.text.slice(from, from + MAX_CHARS);
      const remaining = extracted.text.length - (from + slice.length);

      const head = [
        `# ${extracted.title === '' ? page.url : extracted.title}`,
        page.url,
        page.status === 200 ? '' : `(HTTP ${page.status})`,
      ].filter((line) => line !== '').join('\n');

      const links = from === 0 && extracted.links.length > 0
        ? `\n\n## Links\n${extracted.links.slice(0, MAX_LINKS).map((l) => `- ${l.text}: ${l.href}`).join('\n')}`
        : '';
      const more = remaining > 0
        ? `\n\n(${remaining.toLocaleString()} more characters follow; read again with from=${from + slice.length}.)`
        : '';

      return {
        content: [{ type: 'text' as const, text: `${head}\n\n${slice}${links}${more}` }],
      };
    },
  );

  const search = source.search?.bind(source);
  if (search !== undefined) {
    server.registerTool(
      'search',
      {
        title: 'Search the web',
        description:
          'Search the web and get a short list of pages with a line from each. Use it '
          + 'when you need a page to start from: a company, a product, a fact, a news '
          + 'item, a place. Then read the most promising result with `read_page`; a '
          + 'snippet is a hint, not an answer.',
        inputSchema: {
          query: z.string().trim().min(1).max(300).describe('What to search for, in plain words.'),
          count: z.number().int().min(1).max(MAX_SEARCH).default(5),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args) => {
        let results: readonly SearchResult[];
        try {
          results = await search(args.query, Math.min(args.count ?? 5, MAX_SEARCH));
        } catch (caught) {
          return {
            content: [{ type: 'text' as const, text: caught instanceof Error ? caught.message : 'The search failed.' }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: results.length === 0
              ? 'Nothing came back for that. Try other words.'
              : results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n'),
          }],
        };
      },
    );
  }

  return server;
}

export interface ExtractedPage {
  readonly title: string;
  readonly text: string;
  readonly links: readonly { text: string; href: string }[];
}

/** The words on the page, and where it points. Plain text and JSON pass through untouched. */
export function extract(page: FetchedPage): ExtractedPage {
  const type = page.contentType.toLowerCase();
  if (type.includes('html') || page.body.trimStart().startsWith('<')) {
    return {
      title: titleOf(page.body),
      text: htmlToText(page.body),
      links: linksOf(page.body, page.url),
    };
  }
  return { title: '', text: page.body.trim(), links: [] };
}

export function titleOf(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match === null ? '' : collapse(decodeEntities(stripTags(match[1] ?? '')));
}

/**
 * HTML to text, without a parser.
 *
 * Enough for reading: scripts, styles and hidden boilerplate go, block
 * elements become line breaks, entities become characters, and runs of
 * whitespace become one space. Not a renderer; a reader.
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|header|main|h[1-6]|li|tr|blockquote|pre|table|ul|ol|dd|dt|figcaption|form)>/gi, '\n');
  s = s.replace(/<(h[1-6])\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<\/(td|th)>/gi, '\t');
  s = stripTags(s);
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Links with their visible text, resolved against the page's address. */
export function linksOf(html: string, base: string): readonly { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (raw === '' || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue;
    let href: string;
    try { href = new URL(raw, base).toString(); } catch { continue; }
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    const text = collapse(decodeEntities(stripTags(match[4] ?? '')));
    if (text === '') continue;
    seen.add(href);
    out.push({ text: text.slice(0, 120), href });
  }
  return out;
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, ' ');
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', pound: '£',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeChar(parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith('#')) return safeChar(parseInt(lower.slice(1), 10), whole);
    return NAMED[lower] ?? whole;
  });
}

const safeChar = (code: number, fallback: string): string =>
  Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
