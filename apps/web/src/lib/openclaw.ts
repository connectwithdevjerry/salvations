/**
 * Talking to a person's own agent gateway.
 *
 * The gateway serves an OpenAI-compatible endpoint when its owner turns it
 * on; this is the one client of it here. The address lives on the server
 * row and the token in the credential store, both per assistant, so the
 * source built for a run closes over exactly one gateway.
 *
 * Reference: https://docs.openclaw.ai/gateway/openai-http-api
 */
import { ScopedDb, type Database, type McpServerBindingDoc } from '@salvations/db';
import type { OpenClawAgent, OpenClawSource } from '@salvations/servers';
import { mcpServerById } from './mcp-servers';
import { repositories } from './repositories';
import { assertPublic } from './web-service';

export const OPENCLAW_ALIAS = 'gateway';

const TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 15_000;

/** The gateway's address, cleaned: no trailing slash, no path beyond the origin and a mount prefix. */
export function normaliseGatewayUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The gateway address must start with https://.');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

/** Asks the gateway who it is. Throws with one plain sentence when it will not say. */
export async function probeGateway(url: string, token: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<readonly OpenClawAgent[]> {
  await assertPublic(new URL(url));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (caught) {
    throw new Error(
      controller.signal.aborted ? 'The gateway did not answer in time.' : 'The gateway could not be reached at that address.',
      { cause: caught },
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) throw new Error('The gateway refused the token.');
  if (response.status === 404) {
    throw new Error('The gateway answered, but its chat endpoint is off. Enable gateway.http.endpoints.chatCompletions in openclaw.json and restart.');
  }
  if (!response.ok) throw new Error(`The gateway answered with HTTP ${response.status}.`);
  const body = await response.json().catch(() => ({})) as { data?: { id?: string; name?: string }[] };
  return (body.data ?? [])
    .filter((m) => typeof m.id === 'string' && m.id !== '')
    .map((m) => ({ id: m.id as string, ...(typeof m.name === 'string' ? { name: m.name } : {}) }));
}

export function createOpenClawSource(options: {
  readonly database: Database;
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly fetchImpl?: typeof fetch;
}): OpenClawSource {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  // Resolved once per run, not per call: the address and token do not
  // change mid-conversation, and a decrypt per message is waste.
  let gateway: Promise<{ url: string; token: string }> | undefined;
  const resolve = () => {
    gateway ??= (async () => {
      const binding = await new ScopedDb(options.database, options.workspaceId)
        .collection<McpServerBindingDoc>('mcpServerBindings')
        .findOne({ _id: options.bindingId } as never);
      if (binding === null) throw new Error('This gateway connection no longer exists.');
      const server = await mcpServerById(options.database, options.workspaceId, binding.mcpServerId);
      const url = typeof server?.url === 'string' ? server.url : '';
      if (url === '' || binding.credentialId === null || binding.credentialId === undefined) {
        throw new Error('The gateway is not connected yet. Add its address and token on the Integrations tab.');
      }
      const secret = await repositories(options.database, options.workspaceId).credentials.resolve(binding.credentialId);
      if (secret === null) throw new Error('The gateway token is missing. Connect the gateway again.');
      return { url, token: secret.expose() };
    })();
    return gateway;
  };

  return {
    agents: async () => {
      const { url, token } = await resolve();
      return probeGateway(url, token, fetchImpl);
    },

    async ask({ agentId, message, thread }) {
      const { url, token } = await resolve();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImpl(`${url}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            // The model field names the agent, per the gateway's own contract.
            model: agentId === undefined ? 'openclaw' : agentId.startsWith('openclaw/') || agentId.startsWith('agent:') ? agentId : `openclaw/${agentId}`,
            messages: [{ role: 'user', content: message }],
            // A stable user derives a stable session on the gateway.
            user: thread,
            stream: false,
          }),
        });
      } catch (caught) {
        throw new Error(
          controller.signal.aborted ? 'The gateway agent took too long to answer.' : 'The gateway could not be reached.',
          { cause: caught },
        );
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401 || response.status === 403) throw new Error('The gateway refused the token. Connect the gateway again.');
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`The gateway answered with HTTP ${response.status}${detail === '' ? '.' : `: ${detail.slice(0, 200)}`}`);
      }
      const body = await response.json() as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
          .join('');
      }
      return '';
    },
  };
}
