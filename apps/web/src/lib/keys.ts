/**
 * The key that wraps every stored credential.
 *
 * On its own, deliberately: nearly every request needs a repository that can
 * decrypt a credential, and a repository should not drag the model adapters,
 * the MCP client and the runtime into the function just to get at the KEK.
 */
import { envKeyProvider } from '@salvations/crypto';
import { env } from './env';

export const keyProvider = () => {
  // Validated first, so a missing KEK fails at startup rather than while
  // decrypting a credential for a request that has already been accepted.
  const e = env();
  return envKeyProvider(process.env, e.CREDENTIAL_KEK_VERSION);
};
