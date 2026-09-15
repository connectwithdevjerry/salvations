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

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),

  CREDENTIAL_KEK: z.string().min(1, 'CREDENTIAL_KEK is required'),
  CREDENTIAL_KEK_VERSION: z.coerce.number().int().positive().default(1),

  INTERNAL_HMAC_SECRET: z.string().min(32, 'INTERNAL_HMAC_SECRET must be at least 32 characters'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

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
    BETTER_AUTH_SECRET: e.BETTER_AUTH_SECRET,
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
