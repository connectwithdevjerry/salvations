/**
 * Validated environment.
 *
 * Every secret is read exactly once, here, and a missing one fails at startup
 * rather than at the first request that needs it. A platform that discovers its
 * KEK is absent while decrypting a credential has already accepted the request.
 */
import { z } from 'zod';

const schema = z.object({
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().default('salvations'),

  /** Signs session access tokens. Rotating it signs everyone out. */
  AUTH_JWT_SECRET: z.string().min(32, 'AUTH_JWT_SECRET must be at least 32 characters'),

  /**
   * Sign in with Google.
   *
   * Optional: without it the app still works with email and password, and the
   * Google button simply is not offered. Half-configured is the dangerous
   * state, so the refinement below rejects one without the other.
   */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * A second Google client, for Google Workspace only.
   *
   * Optional. Google verifies a whole Cloud project, and a project that asks
   * for Gmail is held to a long review that a project asking only to sign
   * people in is not. Keeping the two in separate projects lets sign-in be
   * published at once while Workspace stays in testing. Without these, the
   * sign-in client serves both.
   */
  GOOGLE_WORKSPACE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_WORKSPACE_CLIENT_SECRET: z.string().min(1).optional(),

  /**
   * The Meta app behind the Instagram & Facebook integration.
   *
   * Optional. From developers.facebook.com: an app with Facebook Login for
   * Business and the Instagram product on it, with <PUBLIC_BASE_URL>/api/mcp/callback
   * among its valid OAuth redirect URIs. Without these the integration is
   * listed and says what it needs.
   */
  META_APP_ID: z.string().min(1).optional(),
  META_APP_SECRET: z.string().min(1).optional(),

  /**
   * The LinkedIn app behind the LinkedIn integration. Optional. From the
   * LinkedIn developer portal, with the Share on LinkedIn and Sign In with
   * LinkedIn products, and <PUBLIC_BASE_URL>/api/mcp/callback among its
   * redirect URLs. LINKEDIN_SCOPES overrides what consent asks for, for an
   * app that also has Community Management (page posting).
   */
  LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
  LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
  LINKEDIN_SCOPES: z.string().min(1).optional(),

  /**
   * The Slack app behind "Add to Slack". Optional; all three or none.
   *
   * One app, owned by this deployment, that any Slack workspace installs
   * from a button. From api.slack.com/apps → Basic Information → App
   * Credentials. Without these, Slack is still offered, with the person
   * making their own app and pasting its token. See .env.example for what
   * the app itself needs set.
   */
  SLACK_CLIENT_ID: z.string().min(1).optional(),
  SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),

  /**
   * The Discord application behind "Add to Discord". Optional; all four or
   * none. One application, owned by this deployment, that any server adds
   * from a button. From discord.com/developers/applications: the
   * application id and public key on General Information, the client
   * secret under OAuth2, the bot token under Bot. Without these, Discord is
   * still offered, with the person making their own application. See
   * .env.example for what the application itself needs set.
   */
  DISCORD_APPLICATION_ID: z.string().min(1).optional(),
  DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
  DISCORD_PUBLIC_KEY: z.string().min(1).optional(),
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),

  /**
   * OAuth clients registered by hand with vendors whose MCP servers accept
   * neither a client metadata document nor dynamic registration (Asana,
   * HubSpot). JSON, keyed by the vendor's domain:
   *   {"asana.com":{"client_id":"…","client_secret":"…"},"hubspot.com":{…}}
   * Each vendor's developer console issues the pair; the redirect URI to
   * register there is <PUBLIC_BASE_URL>/api/mcp/callback.
   */
  MCP_OAUTH_CLIENTS: z.string().optional().transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === '') return undefined;
    try {
      const parsed = z.record(z.string().min(1), z.object({ client_id: z.string().min(1), client_secret: z.string().min(1).optional() })).parse(JSON.parse(raw));
      return parsed;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'MCP_OAUTH_CLIENTS must be JSON of the form {"vendor.com":{"client_id":"…","client_secret":"…"}}' });
      return z.NEVER;
    }
  }),

  /**
   * Where traces go: an OpenTelemetry collector's OTLP/HTTP endpoint, and
   * any headers it wants (comma-separated key=value pairs). Without an
   * endpoint, spans are collected per run and dropped, which costs nothing.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).default('hive'),

  CREDENTIAL_KEK: z.string().min(1, 'CREDENTIAL_KEK is required'),
  CREDENTIAL_KEK_VERSION: z.coerce.number().int().positive().default(1),
  /** Set by Vercel for scheduled invocations; the sweep accepts it as an alternative to the HMAC. */
  CRON_SECRET: z.string().min(16).optional(),

  /**
   * Outgoing mail, for verification codes. Your own mail server, spoken to
   * directly: an SMTP URL such as smtps://user:password@smtp.example.com:465
   * and the address mail comes from. Without both, no mail is sent and the
   * app says so where a code would be offered.
   */
  SMTP_URL: z.string().url().optional(),
  MAIL_FROM: z.string().min(3).optional(),

  /**
   * Web search for the assistants, through Google's Programmable Search
   * with your own key and search engine id. Search is offered only when
   * both are set; one alone is not an error, because the engine id is set
   * first and the key follows, and a deployment must not fail to start in
   * between.
   */
  GOOGLE_SEARCH_API_KEY: z.string().min(1).optional(),
  GOOGLE_SEARCH_CX: z.string().min(1).optional(),

  INTERNAL_HMAC_SECRET: z.string().min(32, 'INTERNAL_HMAC_SECRET must be at least 32 characters'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  /**
   * Billing.
   *
   * All three or none. A deployment with no processor configured charges
   * nobody and refuses nobody — which is the right behaviour for a private
   * install, and the wrong behaviour to arrive at by accident. Half-configured
   * is the dangerous state: a secret key with no webhook secret takes payments
   * and then never hears that they succeeded, leaving people charged and
   * locked out.
   */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** The processor's id for the plan's price. Differs between test and live. */
  STRIPE_PRICE_ID: z.string().min(1).optional(),
  /**
   * Workspace ids that are never asked to pay: the operator's own, a partner's.
   * Comma-separated. Everyone else starts a free trial or subscribes.
   */
  COMPLIMENTARY_WORKSPACES: z.string().optional().transform((raw) =>
    new Set((raw ?? '').split(',').map((id) => id.trim()).filter((id) => id !== ''))),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
}).refine(
  (value) => (value.GOOGLE_WORKSPACE_CLIENT_ID === undefined) === (value.GOOGLE_WORKSPACE_CLIENT_SECRET === undefined),
  {
    message: 'Set both GOOGLE_WORKSPACE_CLIENT_ID and GOOGLE_WORKSPACE_CLIENT_SECRET, or neither.',
    path: ['GOOGLE_WORKSPACE_CLIENT_ID'],
  },
).refine(
  (value) => (value.META_APP_ID === undefined) === (value.META_APP_SECRET === undefined),
  {
    message: 'Set both META_APP_ID and META_APP_SECRET, or neither.',
    path: ['META_APP_ID'],
  },
).refine(
  (value) => (value.LINKEDIN_CLIENT_ID === undefined) === (value.LINKEDIN_CLIENT_SECRET === undefined),
  {
    message: 'Set both LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET, or neither.',
    path: ['LINKEDIN_CLIENT_ID'],
  },
).refine(
  (value) => {
    const set = [value.SLACK_CLIENT_ID, value.SLACK_CLIENT_SECRET, value.SLACK_SIGNING_SECRET]
      .filter((v) => v !== undefined).length;
    return set === 0 || set === 3;
  },
  {
    message: 'Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET together, or none of them.',
    path: ['SLACK_CLIENT_ID'],
  },
).refine(
  (value) => {
    const set = [value.DISCORD_APPLICATION_ID, value.DISCORD_CLIENT_SECRET, value.DISCORD_PUBLIC_KEY, value.DISCORD_BOT_TOKEN]
      .filter((v) => v !== undefined).length;
    return set === 0 || set === 4;
  },
  {
    message: 'Set DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET, DISCORD_PUBLIC_KEY and DISCORD_BOT_TOKEN together, or none of them.',
    path: ['DISCORD_APPLICATION_ID'],
  },
).refine(
  (value) => (value.SMTP_URL === undefined) === (value.MAIL_FROM === undefined),
  {
    message: 'Set both SMTP_URL and MAIL_FROM, or neither. Mail needs a server and a sender.',
    path: ['SMTP_URL'],
  },
).refine(
  (value) =>
    (value.GOOGLE_CLIENT_ID === undefined) === (value.GOOGLE_CLIENT_SECRET === undefined),
  {
    message:
      'Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither. One without the other ' +
      'offers a sign-in button that cannot complete.',
    path: ['GOOGLE_CLIENT_ID'],
  },
).refine(
  (value) => {
    const set = [value.STRIPE_SECRET_KEY, value.STRIPE_WEBHOOK_SECRET, value.STRIPE_PRICE_ID]
      .filter((v) => v !== undefined).length;
    return set === 0 || set === 3;
  },
  {
    message:
      'Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID together, or none of ' +
      'them. A secret key without a webhook secret takes payments and never hears that they ' +
      'succeeded, which leaves people charged and locked out.',
    path: ['STRIPE_SECRET_KEY'],
  },
);

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached !== undefined) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    // The names are safe to print; the values are never echoed.
    throw new Error(`Invalid environment:\n${issues}\n\nSee .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Distinctness check, run at startup.
 *
 * Reusing one secret across purposes means a leak in any one of them is a leak
 * in all of them — and it is an easy mistake when copying a .env around.
 */
export function assertSecretsAreDistinct(e: Env): void {
  const secrets = {
    AUTH_JWT_SECRET: e.AUTH_JWT_SECRET,
    CREDENTIAL_KEK: e.CREDENTIAL_KEK,
    INTERNAL_HMAC_SECRET: e.INTERNAL_HMAC_SECRET,
  };
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(secrets)) {
    const previous = seen.get(value);
    if (previous !== undefined) {
      throw new Error(
        `${name} and ${previous} are the same value. Each secret must be independent: ` +
          'sharing one means a leak in any one of them is a leak in all of them.',
      );
    }
    seen.set(value, name);
  }
}
