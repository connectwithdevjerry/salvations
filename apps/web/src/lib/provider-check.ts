/**
 * Asking a vendor whether a stored key still works.
 *
 * The verdict is recorded on the provider row, so "connected" on a page means
 * "the vendor said yes, at this time", never merely "a row exists".
 */
import { isPlatformProvider, providerCredentials } from './platform-ai';
import type { ModelBindingRepository, ProviderCheck, ProviderConfigDoc } from '@salvations/db';
import type { CredentialRepository } from '@salvations/db';
import { providers } from './singletons';

export async function checkProviderKey(
  provider: ProviderConfigDoc,
  credentials: CredentialRepository,
  models: ModelBindingRepository,
): Promise<ProviderCheck> {
  const check = await verdict(provider, credentials);
  await models.recordCheck(provider._id, check);
  return check;
}

async function verdict(
  provider: ProviderConfigDoc,
  credentials: CredentialRepository,
): Promise<ProviderCheck> {
  const at = new Date();
  if (!isPlatformProvider(provider) && (provider.credentialId === null || provider.credentialId === undefined)) {
    return { at, ok: false, message: 'No key is stored for this provider.' };
  }
  const given = await providerCredentials(credentials, provider);
  if (given === undefined) {
    return { at, ok: false, message: isPlatformProvider(provider) ? 'This deployment no longer has a key for HIVE AI.' : 'The stored key has been revoked.' };
  }
  const adapter = providers().create(provider.providerType as never, given);
  const result = adapter.verify === undefined ? { ok: true as const } : await adapter.verify();
  return result.ok
    ? { at, ok: true, message: null }
    : { at, ok: false, message: result.message };
}
