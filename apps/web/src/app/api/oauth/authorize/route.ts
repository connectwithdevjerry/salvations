/**
 * The authorization request, checked and decided.
 *
 * GET validates what the client sent and describes it for the consent page:
 * who is asking, for which assistant, in which workspace. POST records the
 * person's answer. Both require the HIVE session cookie — the consent page
 * sends anyone without one to sign in and back.
 *
 * Every refusal that reaches the client goes through its redirect URI only
 * when that URI is one it registered; otherwise the error is shown to the
 * person, never bounced to an address an attacker chose.
 */
import { z } from 'zod';
import { AgentRepository, OAuthServerRepository, WorkspaceRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { readCaller } from '@/lib/session';
import {
  ASSISTANT_SCOPE, assistantResource, parseAssistantResource, redirectUriRegistered,
} from '@/lib/oauth-server';

export const runtime = 'nodejs';

const authorizeRequest = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().regex(/^[A-Za-z0-9\-_]{43}$/, 'S256 challenge expected'),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(1024).optional(),
  scope: z.string().optional(),
  resource: z.string().min(1),
});

type AuthorizeRequest = z.infer<typeof authorizeRequest>;

interface Checked {
  readonly request: AuthorizeRequest;
  readonly client: { id: string; name: string; uri?: string; logo?: string };
  readonly workspace: { id: string; name: string };
  readonly assistant: { id: string; name: string; color: string; description: string };
  readonly userId: string;
}

/** Everything that has to be true before a consent screen is worth showing. */
async function check(input: Record<string, unknown>, request: Request): Promise<Checked | Response> {
  const caller = readCaller(request);
  if (caller === undefined) return errorResponse(401, 'unauthenticated', 'Sign in to continue.');

  const parsed = authorizeRequest.safeParse(input);
  if (!parsed.success) return errorResponse(400, 'invalid_request', 'The authorization request is not valid.');
  const req = parsed.data;

  const target = parseAssistantResource(req.resource);
  if (target === undefined) return errorResponse(400, 'invalid_target', 'That resource is not an assistant on this platform.');

  if (req.scope !== undefined && req.scope.split(' ').some((s) => s !== '' && s !== ASSISTANT_SCOPE)) {
    return errorResponse(400, 'invalid_scope', `Only the "${ASSISTANT_SCOPE}" scope is offered.`);
  }

  const handle = await db();
  const client = await new OAuthServerRepository(handle.db).findClient(req.client_id);
  if (client === null) return errorResponse(400, 'invalid_client', 'Unknown client.');
  if (!redirectUriRegistered(client.redirectUris, req.redirect_uri)) {
    return errorResponse(400, 'invalid_request', 'The redirect URI is not one this client registered.');
  }

  const membership = await new WorkspaceRepository(handle.db).membershipOf(target.workspaceId, caller.userId);
  const workspace = membership === null ? null : await new WorkspaceRepository(handle.db).findById(target.workspaceId);
  if (membership === null || workspace === null) {
    return errorResponse(404, 'not_found', 'That assistant is not in a workspace you belong to.');
  }
  const agent = await new AgentRepository(handle.db, target.workspaceId).findById(target.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'That assistant no longer exists.');

  return {
    request: req,
    client: {
      id: client._id, name: client.name,
      ...(client.clientUri ? { uri: client.clientUri } : {}),
      ...(client.logoUri ? { logo: client.logoUri } : {}),
    },
    workspace: { id: workspace._id, name: workspace.name },
    assistant: { id: agent._id, name: agent.name, color: agent.color ?? '#3b82f6', description: agent.description ?? '' },
    userId: caller.userId,
  };
}

const describe = (checked: Checked) => ({
  client: checked.client,
  workspace: checked.workspace,
  assistant: checked.assistant,
  redirectHost: new URL(checked.request.redirect_uri).host,
});

export async function GET(request: Request): Promise<Response> {
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const checked = await check(params, request);
    if (checked instanceof Response) return checked;
    return ok(describe(checked));
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}

const decision = z.object({
  decision: z.enum(['allow', 'deny']),
  request: z.record(z.string(), z.string()),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await jsonBody(request, decision);
    const checked = await check(body.request, request);
    if (checked instanceof Response) return checked;

    const back = new URL(checked.request.redirect_uri);
    if (checked.request.state !== undefined) back.searchParams.set('state', checked.request.state);

    if (body.decision === 'deny') {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', 'The person declined.');
      return ok({ redirectTo: back.toString() });
    }

    const handle = await db();
    const code = await new OAuthServerRepository(handle.db).issueCode(
      {
        workspaceId: checked.workspace.id,
        userId: checked.userId,
        agentId: checked.assistant.id,
        clientId: checked.client.id,
        scope: ASSISTANT_SCOPE,
        resource: assistantResource(checked.workspace.id, checked.assistant.id),
      },
      { redirectUri: checked.request.redirect_uri, codeChallenge: checked.request.code_challenge },
    );
    back.searchParams.set('code', code);
    // RFC 9207: the client can confirm which server answered.
    back.searchParams.set('iss', new URL(request.url).origin);
    return ok({ redirectTo: back.toString() });
  } catch (error) {
    return errorResponse.fromUnknown(error);
  }
}
