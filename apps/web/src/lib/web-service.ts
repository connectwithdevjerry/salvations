/**
 * Fetching a page for the web tool.
 *
 * What may be reached is decided here, once. Only http and https, only
 * hosts that resolve to public addresses: a tool that would fetch
 * 10.0.0.1 or the platform's metadata endpoint is a tool that reads the
 * inside of the network it runs in on an attacker's behalf, and the
 * argument that reaches it is written by a model reading untrusted text.
 * Redirects are followed by hand so each hop is checked the same way.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FetchedPage, WebSource } from '@salvations/servers';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'HIVE assistant (+https://hive.yashayah.cloud)';

/** Whether an IP address belongs to a private, loopback, link-local or otherwise non-public range. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9')
      || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('ff');
  }
  return true;
}

/** Throws unless the address is a public web address. */
export async function assertPublic(target: URL): Promise<void> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be read.');
  }
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('That address is not on the public internet.');
  }
  const addresses = isIP(host) !== 0
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => { throw new Error(`${host} could not be found.`); });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('That address is not on the public internet.');
  }
}

export function createWebSource(fetchImpl: typeof fetch = globalThis.fetch): WebSource {
  return {
    async fetch(url: string): Promise<FetchedPage> {
      let current = new URL(url);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await assertPublic(current);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetchImpl(current.toString(), {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
          });
        } catch (caught) {
          throw new Error(controller.signal.aborted
            ? 'That page took too long to answer.'
            : `That page could not be reached: ${caught instanceof Error ? caught.message : String(caught)}`);
        } finally {
          clearTimeout(timer);
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location === null) throw new Error('That page redirected nowhere.');
          current = new URL(location, current);
          continue;
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!/text\/|html|xml|json/i.test(contentType) && contentType !== '') {
          throw new Error(`That address is a ${contentType.split(';')[0]} file, not a page to read.`);
        }
        const body = await readUpTo(response, MAX_BYTES);
        return { url: current.toString(), status: response.status, contentType, body };
      }
      throw new Error('That page redirects too many times.');
    },
  };
}

async function readUpTo(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return await response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) { await reader.cancel().catch(() => undefined); break; }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks, Math.min(total, limit)));
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= length) break;
  }
  return out;
}
