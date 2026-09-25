import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createWebServer, extract, htmlToText, linksOf, MAX_CHARS, type WebSource } from './web';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = {
  workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1',
};

const PAGE = `<!doctype html><html><head><title> Okoro &amp; Sons </title><style>body{}</style>
<script>alert(1)</script></head><body><nav><a href="/home">Home</a></nav>
<h1>Prices</h1><p>Rice is &pound;12 per bag.<br>Beans &#163;9.</p>
<ul><li>Delivery <a href="/delivery">here</a></li><li>Returns</li></ul>
<a href="https://example.com/a">A</a> <a href="#top">Top</a> <a href="mailto:x@y">Mail</a>
<footer>Copyright</footer></body></html>`;

async function connect(source: WebSource) {
  const server = createWebServer(CONTEXT, source);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (result: { content: unknown }) => (result.content as { text: string }[])[0]?.text ?? '';

describe('reading html', () => {
  it('keeps the words and drops the scaffolding', () => {
    const text = htmlToText(PAGE);
    expect(text).toContain('Prices');
    expect(text).toContain('Rice is £12 per bag.');
    expect(text).toContain('Beans £9.');
    expect(text).toContain('- Delivery here');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('body{}');
    expect(text).not.toContain('Copyright');
    expect(text).not.toContain('Home');
  });

  it('lists real links, resolved, once, and leaves anchors and mailto out', () => {
    const links = linksOf(PAGE, 'https://okoro.example/shop/');
    expect(links).toEqual([
      { text: 'Home', href: 'https://okoro.example/home' },
      { text: 'here', href: 'https://okoro.example/delivery' },
      { text: 'A', href: 'https://example.com/a' },
    ]);
  });

  it('reads a title and passes plain text through', () => {
    expect(extract({ url: 'u', status: 200, contentType: 'text/html', body: PAGE }).title).toBe('Okoro & Sons');
    expect(extract({ url: 'u', status: 200, contentType: 'text/plain', body: '  hello\n' })).toEqual({ title: '', text: 'hello', links: [] });
  });
});

describe('the web server', () => {
  it('offers one read-only tool that takes an address', async () => {
    const { client, close } = await connect({ fetch: async () => { throw new Error('unused'); } });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['read_page']);
      expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    } finally { await close(); }
  });

  it('returns the page as text with its links, and pages a long one', async () => {
    const long = `<html><body><p>${'word '.repeat(5_000)}</p></body></html>`;
    const source: WebSource = {
      fetch: async (url) => ({ url, status: 200, contentType: 'text/html; charset=utf-8', body: url.endsWith('long') ? long : PAGE }),
    };
    const { client, close } = await connect(source);
    try {
      const short = textOf(await client.callTool({ name: 'read_page', arguments: { url: 'https://okoro.example/shop' } }));
      expect(short.startsWith('# Okoro & Sons\nhttps://okoro.example/shop')).toBe(true);
      expect(short).toContain('Rice is £12 per bag.');
      expect(short).toContain('## Links\n- Home: https://okoro.example/home');

      const first = textOf(await client.callTool({ name: 'read_page', arguments: { url: 'https://okoro.example/long' } }));
      expect(first).toContain(`read again with from=${MAX_CHARS}`);
      const second = textOf(await client.callTool({ name: 'read_page', arguments: { url: 'https://okoro.example/long', from: MAX_CHARS } }));
      expect(second).not.toContain('## Links');
      expect(second).toContain(`read again with from=${MAX_CHARS * 2}`);
      const last = textOf(await client.callTool({ name: 'read_page', arguments: { url: 'https://okoro.example/long', from: MAX_CHARS * 2 } }));
      expect(last).not.toContain('more characters follow');
    } finally { await close(); }
  });

  it('says why when a page cannot be read, as an error', async () => {
    const { client, close } = await connect({ fetch: async () => { throw new Error('That address is not on the public internet.'); } });
    try {
      const result = await client.callTool({ name: 'read_page', arguments: { url: 'http://10.0.0.1/' } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('That address is not on the public internet.');
    } finally { await close(); }
  });
});
