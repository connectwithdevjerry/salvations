/**
 * Asking a vendor whether a stored key still works.
 *
 * The verdict is recorded on the provider row, so "connected" on a page means
 * "the vendor said yes, at this time", never merely "a row exists".
 */
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
  if (provider.credentialId === null || provider.credentialId === undefined) {
    return { at, ok: false, message: 'No key is stored for this provider.' };
  }
  const secret = await credentials.resolve(provider.credentialId);
  if (secret === null) {
    return { at, ok: false, message: 'The stored key has been revoked.' };
  }
  const adapter = providers().create(provider.providerType as never, {
    apiKey: secret.expose(),
    ...(provider.baseUrl !== null && provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
  });
  const result = adapter.verify === undefined ? { ok: true as const } : await adapter.verify();
  return result.ok
    ? { at, ok: true, message: null }
    : { at, ok: false, message: result.message };
}
