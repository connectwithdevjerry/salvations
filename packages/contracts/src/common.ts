/**
 * Shared request and response shapes.
 *
 * The API and the UI both import these, so a change to a payload is a type
 * error on both sides in the same commit. A hand-written client type is a
 * second definition of the same thing, and one of the two is always stale.
 *
 * Everything here VALIDATES rather than merely describes: these schemas run on
 * untrusted input at the edge of the server, and a type that only exists at
 * compile time stops nothing.
 */
import { z } from 'zod';

/** UUIDv7 with a type prefix — `run_0192…`. */
export const idSchema = z
  .string()
  .regex(/^[a-z]{2,5}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'not a valid id');

/**
 * Text a person typed.
 *
 * Bounded on the way in. An unbounded string reaches a model as tokens someone
 * else pays for, and reaches the database as a document that may exceed its
 * size limit at write time rather than at input time.
 */
export const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const nameSchema = boundedText(120);
export const descriptionSchema = z.string().trim().max(2_000);

/** `<alias>__<tool>` namespacing means the alias itself must be name-safe. */
export const aliasSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,30}$/, 'an alias is lowercase letters, digits and underscores');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().optional() });

/**
 * The one error shape every route returns.
 *
 * `code` is stable and `message` is safe to show. Anything not explicitly
 * exposed by the domain is reported generically — an error string is a classic
 * accidental disclosure channel.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const roleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export const permissionEffectSchema = z.enum(['allow', 'ask', 'deny']);
export const trustTierSchema = z.enum(['first_party', 'verified', 'community', 'untrusted']);

export const runStatusSchema = z.enum([
  'queued', 'running',
  'waiting_approval', 'waiting_input', 'waiting_tool',
  'succeeded', 'failed', 'cancelled', 'expired',
]);

export const usageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
});

export const consumptionSchema = z.object({
  steps: z.number().int().min(0),
  toolCalls: z.number().int().min(0),
  tokens: z.number().int().min(0),
  wallClockMs: z.number().int().min(0),
  costUsd: z.number().min(0),
});

/**
 * A budget a caller may ask for.
 *
 * Every field is capped here as well as enforced at runtime. A caller that can
 * name its own ceiling has no budget at all, and the server-side clamp is the
 * only one an untrusted client cannot edit.
 */
export const budgetRequestSchema = z.object({
  maxSteps: z.number().int().min(1).max(200).optional(),
  maxToolCalls: z.number().int().min(0).max(500).optional(),
  maxTotalTokens: z.number().int().min(1_000).max(2_000_000).optional(),
  maxWallClockMs: z.number().int().min(1_000).max(3_600_000).optional(),
  maxCostUsd: z.number().min(0).max(50).optional(),
  maxMrtrRounds: z.number().int().min(0).max(16).optional(),
});

export const contentBlockSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), blobKey: z.string(), mime: z.string() }),
    z.object({
      type: z.literal('document'), blobKey: z.string(), mime: z.string(),
      title: z.string().optional(),
    }),
    z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
    z.object({
      type: z.literal('tool_result'), toolUseId: z.string(),
      content: z.array(contentBlockSchema), structured: z.unknown().optional(),
      isError: z.boolean(),
    }),
    z.object({
      type: z.literal('reasoning'), summary: z.string().optional(), redacted: z.boolean(),
    }),
    z.object({
      type: z.literal('blob_ref'), key: z.string(), bytes: z.number().int(), mime: z.string(),
    }),
  ]),
);
