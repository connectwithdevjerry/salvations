/**
 * Recall, assembled.
 *
 * Retrieval ranks in this process rather than in the database, and that is a
 * deliberate choice with a shelf life. Atlas Vector Search would do it
 * server-side and scale further, but it exists only on Atlas — a self-hosted
 * MongoDB, and the one CI runs against, have no `$vectorSearch` at all. Ranking
 * here works everywhere, is testable, and is comfortably fast for the number of
 * memories one agent accumulates. The candidate cap is what keeps that true.
 *
 * Embeddings are optional throughout. A workspace with nothing bound to the
 * `embedding` role still gets lexical and recency ranking, which is most of the
 * value; it does not get paraphrase matching, and nothing pretends otherwise.
 */
import { MemoryRepository, ModelBindingRepository, CredentialRepository } from '@salvations/db';
import type { Database, MemoryEntryDoc } from '@salvations/db';
import { cosine, embeddingKey, rank, DEFAULT_IMPORTANCE } from '@salvations/memory';
import type { MemorySource } from '@salvations/servers';
import { providers, keyProvider } from './container';

/** The role a workspace binds to say which model turns text into vectors. */
export const EMBEDDING_ROLE = 'embedding';

/** Below this, a memory is not relevant enough to be worth the context. */
export const RELEVANCE_FLOOR = 0.08;

interface Embedder {
  readonly key: string;
  embed(text: string): Promise<readonly number[] | undefined>;
}

/**
 * The workspace's embedding model, if it has one.
 *
 * Resolved once per run and reused, because a recall and the remember that
 * follows it should use the same model — vectors from two models are not
 * comparable, and silently mixing them within one run would poison the very
 * entries just written.
 */
async function embedderFor(
  database: Database,
  workspaceId: string,
): Promise<Embedder | undefined> {
  const bindings = new ModelBindingRepository(database, workspaceId);
  const binding = await bindings.forRole(EMBEDDING_ROLE);
  if (binding === null) return undefined;

  const providerRow = await bindings.providerFor(binding);
  if (providerRow === null) return undefined;

  const registry = providers();
  if (!registry.has(providerRow.providerType as never)) return undefined;

  const credentials = new CredentialRepository(database, workspaceId, keyProvider());
  const secret = providerRow.credentialId == null
    ? null
    : await credentials.resolve(providerRow.credentialId);

  const provider = registry.create(
    providerRow.providerType as never,
    secret === null ? {} : { apiKey: secret.expose() },
  );
  // Optional on the port. A workspace that bound a model with no embedding
  // support degrades to lexical rather than failing every recall.
  if (provider.embed === undefined) return undefined;

  return {
    key: embeddingKey(String(providerRow.providerType), binding.modelId),
    async embed(text) {
      try {
        const result = await provider.embed?.({ modelId: binding.modelId, inputs: [text] });
        return result?.vectors[0];
      } catch {
        // A failed embedding degrades recall; it must not fail the run. The
        // lexical and recency signals still work.
        return undefined;
      }
    },
  };
}

export function createMemorySource(options: {
  database: Database;
  workspaceId: string;
  agentId: string;
  runId: string;
  createdBy?: string | undefined;
}): MemorySource {
  const repo = new MemoryRepository(options.database, options.workspaceId);
  let embedder: Embedder | undefined;
  let resolved = false;

  const embedderOnce = async (): Promise<Embedder | undefined> => {
    if (!resolved) {
      embedder = await embedderFor(options.database, options.workspaceId);
      resolved = true;
    }
    return embedder;
  };

  return {
    async remember(input) {
      const model = await embedderOnce();
      const vector = model === undefined ? undefined : await model.embed(input.content);

      const { entry, superseded } = await repo.remember({
        agentId: options.agentId,
        kind: input.kind,
        key: input.key,
        content: input.content,
        importance: input.importance ?? DEFAULT_IMPORTANCE,
        sourceRunId: options.runId,
        createdBy: options.createdBy,
        embeddings: model !== undefined && vector !== undefined
          ? { [model.key]: [...vector] }
          : undefined,
      });

      // Reported by the write itself. The first memory under a key replaces
      // nothing, and saying otherwise would be a small, needless untruth.
      return { id: entry._id, superseded };
    },

    async recall(query, limit) {
      const candidates = await repo.current(options.agentId);
      if (candidates.length === 0) return [];

      const model = await embedderOnce();
      const queryVector = model === undefined ? undefined : await model.embed(query);

      const scored = rank(query, candidates.map((entry) => ({
        entry,
        content: entry.content,
        importance: entry.importance,
        validFrom: entry.validFrom,
        ...similarityOf(entry, model?.key, queryVector),
      })));

      return scored
        // A weak match is worse than no match: it spends context and invites
        // the agent to act on something that is not about the question.
        .filter((result) => result.score >= RELEVANCE_FLOOR)
        .slice(0, limit)
        .map((result) => ({
          id: result.item.entry._id,
          kind: result.item.entry.kind,
          key: result.item.entry.key ?? undefined,
          content: result.item.entry.content,
          validFrom: result.item.entry.validFrom,
        }));
    },

    async forget(entryId) {
      return repo.forget(options.agentId, entryId);
    },

    async history(key, limit) {
      const entries = await repo.history(options.agentId, key, limit);
      return entries.map((entry) => ({
        content: entry.content,
        validFrom: entry.validFrom,
        validTo: entry.validTo ?? null,
      }));
    },
  };
}

/**
 * The similarity term, when there is one.
 *
 * Absent — rather than zero — when this entry has no vector under the model
 * currently in use. That happens routinely: a memory written before an
 * embedding model was configured, or under a model since replaced. Scoring it
 * as zero would bury every older memory beneath whatever was written most
 * recently, which is the opposite of what memory is for.
 */
function similarityOf(
  entry: MemoryEntryDoc,
  modelKey: string | undefined,
  queryVector: readonly number[] | undefined,
): { similarity?: number } {
  if (modelKey === undefined || queryVector === undefined) return {};

  const stored = entry.embeddings?.[modelKey];
  if (stored === undefined || stored.length !== queryVector.length) return {};

  return { similarity: cosine(stored, queryVector) };
}
