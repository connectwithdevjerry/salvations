/**
 * Serving a first-party server over HTTP.
 *
 * The SDK's web-standard handler, wrapped so the application never imports
 * the protocol SDK itself (invariant I5). A route hands in a factory that
 * builds the server for one request — the assistant, scoped to itself, with
 * the caller already authenticated by the route — and gets back a
 * `(Request) => Promise<Response>`.
 *
 * Stateless by construction: every request builds its own instance and holds
 * nothing between calls, which is the only posture that survives a serverless
 * deployment where two requests need not land on the same process.
 */
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

export type HttpServerFactory = () => McpServer | Promise<McpServer>;

export function serveOverHttp(factory: HttpServerFactory): (request: Request) => Promise<Response> {
  const handler = createMcpHandler(() => factory(), {
    legacy: 'stateless',
    // Always a single JSON body: a serverless function must answer and end,
    // and nothing here emits mid-call notifications a stream would carry.
    responseMode: 'json',
  });
  return (request) => handler.fetch(request);
}
