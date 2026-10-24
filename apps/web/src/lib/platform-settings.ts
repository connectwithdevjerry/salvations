/**
 * The deployment's own keys, from the dashboard first and the environment
 * second.
 *
 * Every integration the deployment owns (its Slack and Discord apps, its
 * Meta app, HIVE AI's model key) used to be configured only through
 * environment variables, which means a redeploy to rotate a key. Now each
 * of those settings may also be set from the admin dashboard by a platform
 * admin, and a value set there wins over the environment. The environment
 * stays as the fallback and as the way to bootstrap: the list of platform
 * admins itself lives there, because somebody has to be able to open the
 * dashboard before anything is in it.
 *
 * Values are read through one cache per process, a minute at most old, so a
 * change made on the dashboard reaches every running instance within that
 * minute and the instance that made it at once.
 */
import { PlatformSettingsRepository, UserRepository, type Database } from '@salvations/db';
import { db } from './db';
import { env } from './env';
import { keyProvider } from './keys';

export type SettingGroup = 'ai' | 'slack' | 'discord' | 'meta' | 'linkedin' | 'google';

export interface PlatformSettingSpec {
  readonly key: string;
  /** The environment variable that stands in when the dashboard has no value. */
  readonly env: string;
  readonly label: string;
  readonly help: string;
  readonly secret: boolean;
  readonly group: SettingGroup;
  readonly placeholder?: string;
}

export const SETTING_GROUPS: Readonly<Record<SettingGroup, { title: string; lede: string }>> = {
  ai: { title: 'HIVE AI', lede: 'The model that comes with the subscription. The deployment pays the vendor; each workspace gets a monthly allowance.' },
  slack: { title: 'Slack app', lede: 'The app behind "Add to Slack". From api.slack.com/apps, Basic Information.' },
  discord: { title: 'Discord application', lede: 'The application behind "Add to Discord". From the Discord developer portal.' },
  meta: { title: 'Meta app', lede: 'Instagram and Facebook publishing, and WhatsApp in one press. From developers.facebook.com.' },
  linkedin: { title: 'LinkedIn app', lede: 'LinkedIn publishing. From the LinkedIn developer portal, under Auth.' },
  google: { title: 'Google Workspace client', lede: 'Gmail, Calendar and Drive. A Cloud project of its own, so Workspace review does not hold up sign-in.' },
};

export const PLATFORM_SETTINGS: readonly PlatformSettingSpec[] = [
  { key: 'platform_ai_api_key', env: 'PLATFORM_AI_API_KEY', label: 'API key', help: 'The vendor key HIVE AI runs on. Rotating it here takes effect within a minute.', secret: true, group: 'ai', placeholder: 'sk-…' },
  { key: 'platform_ai_provider', env: 'PLATFORM_AI_PROVIDER', label: 'Vendor', help: 'openai or anthropic. Must match the key.', secret: false, group: 'ai', placeholder: 'openai' },
  { key: 'platform_ai_chat_model', env: 'PLATFORM_AI_CHAT_MODEL', label: 'Chat model', help: 'A catalogue model id for that vendor. Empty means the vendor\'s default.', secret: false, group: 'ai', placeholder: 'gpt-4.1' },
  { key: 'platform_ai_monthly_usd_cap', env: 'PLATFORM_AI_MONTHLY_USD_CAP', label: 'Monthly allowance per workspace', help: 'In dollars. Once a workspace has spent this much of HIVE AI in a month it is asked to bring its own key or wait.', secret: false, group: 'ai', placeholder: '25' },
  { key: 'platform_ai_base_url', env: 'PLATFORM_AI_BASE_URL', label: 'Base URL', help: 'Only for a proxy or a compatible endpoint. Empty means the vendor\'s own.', secret: false, group: 'ai', placeholder: 'https://' },

  { key: 'slack_client_id', env: 'SLACK_CLIENT_ID', label: 'Client ID', help: 'Basic Information → App Credentials.', secret: false, group: 'slack' },
  { key: 'slack_client_secret', env: 'SLACK_CLIENT_SECRET', label: 'Client secret', help: 'Basic Information → App Credentials.', secret: true, group: 'slack' },
  { key: 'slack_signing_secret', env: 'SLACK_SIGNING_SECRET', label: 'Signing secret', help: 'Basic Information → App Credentials. Verifies every delivery to the shared address.', secret: true, group: 'slack' },

  { key: 'discord_application_id', env: 'DISCORD_APPLICATION_ID', label: 'Application ID', help: 'General Information.', secret: false, group: 'discord' },
  { key: 'discord_public_key', env: 'DISCORD_PUBLIC_KEY', label: 'Public key', help: 'General Information. Verifies every interaction to the shared endpoint.', secret: false, group: 'discord' },
  { key: 'discord_client_secret', env: 'DISCORD_CLIENT_SECRET', label: 'Client secret', help: 'OAuth2.', secret: true, group: 'discord' },
  { key: 'discord_bot_token', env: 'DISCORD_BOT_TOKEN', label: 'Bot token', help: 'Bot → Reset Token. Every connected server holds a copy; rotating it here updates them within a day.', secret: true, group: 'discord' },

  { key: 'meta_app_id', env: 'META_APP_ID', label: 'App ID', help: 'Shown at the top of the App Dashboard.', secret: false, group: 'meta' },
  { key: 'meta_app_secret', env: 'META_APP_SECRET', label: 'App secret', help: 'App settings → Basic. Signs every WhatsApp delivery to the shared address.', secret: true, group: 'meta' },
  { key: 'meta_whatsapp_config_id', env: 'META_WHATSAPP_CONFIG_ID', label: 'WhatsApp sign-up configuration ID', help: 'Facebook Login for Business → Configurations, the one with Embedded Signup. Empty turns WhatsApp in one press off.', secret: false, group: 'meta' },
  { key: 'meta_whatsapp_verify_token', env: 'META_WHATSAPP_VERIFY_TOKEN', label: 'WhatsApp webhook verify token', help: 'The same string typed beside the callback URL under WhatsApp → Configuration. Eight characters or more.', secret: true, group: 'meta' },

  { key: 'linkedin_client_id', env: 'LINKEDIN_CLIENT_ID', label: 'Client ID', help: 'Auth → Application credentials.', secret: false, group: 'linkedin' },
  { key: 'linkedin_client_secret', env: 'LINKEDIN_CLIENT_SECRET', label: 'Client secret', help: 'Auth → Application credentials.', secret: true, group: 'linkedin' },

  { key: 'google_workspace_client_id', env: 'GOOGLE_WORKSPACE_CLIENT_ID', label: 'Client ID', help: 'The OAuth client of the Workspace project. Empty falls back to the sign-in client.', secret: false, group: 'google' },
  { key: 'google_workspace_client_secret', env: 'GOOGLE_WORKSPACE_CLIENT_SECRET', label: 'Client secret', help: 'The same client\'s secret.', secret: true, group: 'google' },
];

const BY_KEY: ReadonlyMap<string, PlatformSettingSpec> = new Map(PLATFORM_SETTINGS.map((s) => [s.key, s]));

export const settingSpec = (key: string): PlatformSettingSpec | undefined => BY_KEY.get(key);

/** How long dashboard values are trusted before the database is read again. */
const CACHE_MS = 60_000;

type Loader = () => Promise<ReadonlyMap<string, string>>;

let loader: Loader | undefined;
let cached: { at: number; values: ReadonlyMap<string, string> } | undefined;

/** Replaces where dashboard values come from. For tests, which have no database. */
export function configurePlatformSettings(custom: Loader | undefined): void {
  loader = custom;
  cached = undefined;
}

/** Forgets what was read, so the next read sees a change made a moment ago. */
export function invalidatePlatformSettings(): void {
  cached = undefined;
}

async function fromDatabase(): Promise<ReadonlyMap<string, string>> {
  const handle = await db();
  return new PlatformSettingsRepository(handle.db, keyProvider()).readAll();
}

async function dashboardValues(): Promise<ReadonlyMap<string, string>> {
  if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.values;
  const values = await (loader ?? fromDatabase)();
  cached = { at: Date.now(), values };
  return values;
}

/** What the environment has for a setting, through the validated env where it is declared. */
function fromEnvironment(spec: PlatformSettingSpec): string | undefined {
  const declared = (env() as unknown as Record<string, unknown>)[spec.env];
  if (typeof declared === 'string' && declared !== '') return declared;
  if (typeof declared === 'number') return String(declared);
  const raw = process.env[spec.env];
  return raw === undefined || raw === '' ? undefined : raw;
}

/** The value in force for a setting: the dashboard's, else the environment's, else nothing. */
export async function platformSetting(key: string): Promise<string | undefined> {
  const spec = settingSpec(key);
  if (spec === undefined) throw new Error(`There is no platform setting called "${key}".`);
  const set = (await dashboardValues()).get(key);
  if (set !== undefined && set !== '') return set;
  return fromEnvironment(spec);
}

/** Several at once, in the order asked. */
export async function platformSettings<const K extends readonly string[]>(keys: K): Promise<{ [I in keyof K]: string | undefined }> {
  return await Promise.all(keys.map((k) => platformSetting(k))) as { [I in keyof K]: string | undefined };
}

export interface SettingState {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly secret: boolean;
  readonly group: SettingGroup;
  readonly placeholder?: string;
  /** Where the value in force comes from. */
  readonly source: 'dashboard' | 'environment' | 'unset';
  /** The value for a setting that is not secret; the last four characters for one that is. */
  readonly hint?: string;
  readonly updatedAt?: string;
}

/** Every setting with where its value comes from, for the dashboard. Secrets never appear. */
export async function describePlatformSettings(database: Database): Promise<SettingState[]> {
  const stored = new Map((await new PlatformSettingsRepository(database, keyProvider()).list()).map((s) => [s.key, s]));
  return PLATFORM_SETTINGS.map((spec) => {
    const row = stored.get(spec.key);
    if (row !== undefined) {
      return { ...spec, source: 'dashboard' as const, hint: row.hint, updatedAt: row.updatedAt.toISOString() };
    }
    const fromEnv = fromEnvironment(spec);
    if (fromEnv !== undefined) {
      return { ...spec, source: 'environment' as const, hint: spec.secret ? `••••${fromEnv.slice(-4)}` : fromEnv };
    }
    return { ...spec, source: 'unset' as const };
  });
}

/** Whether a signed-in person may change the deployment's settings: their address is on the operator's list. */
export async function isPlatformAdmin(database: Database, userId: string): Promise<boolean> {
  const admins = env().PLATFORM_ADMIN_EMAILS;
  if (admins.size === 0) return false;
  const user = await new UserRepository(database).findById(userId);
  return user !== null && admins.has(user.email.toLowerCase());
}
