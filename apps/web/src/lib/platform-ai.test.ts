import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelsFor } from '@salvations/catalog';

const BASE = {
  MONGODB_URI: 'mongodb://localhost/test',
  AUTH_JWT_SECRET: 'a-long-enough-test-secret-value-for-jwt-000000',
  CREDENTIAL_KEK: 'kek',
  INTERNAL_HMAC_SECRET: 'a-long-enough-test-secret-value-for-hmac-000',
};

async function fresh(extra: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PLATFORM_AI_')) delete process.env[key];
  }
  Object.assign(process.env, BASE, extra);
  // The env module caches; a fresh import reads what this test set.
  vi.resetModules();
  const envModule = await import('./env');
  const settings = await import('./platform-settings');
  // No database in a test: the dashboard holds nothing, the environment decides.
  settings.configurePlatformSettings(async () => new Map());
  const platformModule = await import('./platform-ai');
  return { ...platformModule, env: envModule.env };
}

describe('HIVE AI', () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env = { ...saved }; });
  afterEach(() => { process.env = saved; });

  it('is absent without a key, and OpenAI with the vendor\'s default chat model when one is set', async () => {
    const none = await fresh({});
    expect(await none.platformAi()).toBeUndefined();

    const some = await fresh({ PLATFORM_AI_API_KEY: 'sk-platform' });
    const platform = await some.platformAi();
    expect(platform?.providerType).toBe('openai');
    expect(platform?.apiKey).toBe('sk-platform');
    expect(platform?.chatModelId).toBe(modelsFor('openai').find((m) => m.roles.includes('chat'))?.id);
    expect(platform?.monthlyUsdCap).toBe(25);
  });

  it('takes another known vendor, a listed chat model and a cap, and refuses what it cannot serve', async () => {
    const anthropicChat = modelsFor('anthropic').find((m) => m.roles.includes('chat'))?.id ?? '';
    const some = await fresh({
      PLATFORM_AI_API_KEY: 'sk-ant-platform', PLATFORM_AI_PROVIDER: 'anthropic',
      PLATFORM_AI_CHAT_MODEL: anthropicChat, PLATFORM_AI_MONTHLY_USD_CAP: '40',
    });
    expect(await some.platformAi()).toMatchObject({ providerType: 'anthropic', chatModelId: anthropicChat, monthlyUsdCap: 40 });

    const unknownModel = await fresh({ PLATFORM_AI_API_KEY: 'k', PLATFORM_AI_CHAT_MODEL: 'gpt-imaginary' });
    await expect(unknownModel.platformAi()).rejects.toThrow(/not a openai model/);
    const unknownVendor = await fresh({ PLATFORM_AI_API_KEY: 'k', PLATFORM_AI_PROVIDER: 'mistral' });
    await expect(unknownVendor.platformAi()).rejects.toThrow(/no adapter/);
  });

  it('binds the vendor\'s defaults under the HIVE AI name, with the chosen chat model and catalogue rates', async () => {
    const some = await fresh({ PLATFORM_AI_API_KEY: 'k', PLATFORM_AI_CHAT_MODEL: 'gpt-4.1' });
    const bindings = some.platformBindings((await some.platformAi())!);
    const chat = bindings.find((b) => b.role === 'chat');
    expect(chat?.modelId).toBe('gpt-4.1');
    expect(chat?.displayName).toMatch(/^HIVE AI · /);
    expect(bindings.map((b) => b.role)).toEqual(expect.arrayContaining(['chat', 'transcription', 'embedding']));
    for (const b of bindings) expect(b.inputPerMTok).toBeGreaterThanOrEqual(0);
  });

  it('hands the deployment\'s key to a platform provider and the stored key to the rest', async () => {
    const some = await fresh({ PLATFORM_AI_API_KEY: 'sk-platform' });
    const credentials = { resolve: async (id: string) => (id === 'cred_1' ? { expose: () => 'sk-own' } : null) } as never;
    expect(await some.providerCredentials(credentials, { platform: true, credentialId: null, baseUrl: null })).toEqual({ apiKey: 'sk-platform' });
    expect(await some.providerCredentials(credentials, { platform: false, credentialId: 'cred_1', baseUrl: 'https://proxy.example' }))
      .toEqual({ apiKey: 'sk-own', baseUrl: 'https://proxy.example' });
    expect(await some.providerCredentials(credentials, { credentialId: null, baseUrl: null })).toBeUndefined();
    expect(some.allowanceReason(25)).toMatch(/\$25 has been used up/);
  });
});
