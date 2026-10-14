/**
 * Prompt assembly.
 *
 * Every provider with a prompt cache keys on an EXACT prefix match. One
 * reordered tool, one timestamp in the system prompt, one `Object.keys()` walk
 * over a map, and the prefix changes — the cache misses, and the run pays full
 * input price on a prompt it has already paid for. At agent-loop lengths that is
 * most of the bill.
 *
 * So the rule here is stronger than "usually stable": the prefix is a pure
 * function of inputs that a caller cannot accidentally perturb. Anything
 * varying (the newest turn, this step's tool results) goes after the last cache
 * breakpoint, never before it.
 */
import {
  artifactsForModel, canonicalJson, fingerprint, textBlock, toolResultBlock, toolUseBlocks,
  type CanonicalMessage, type ContentBlock, type GenerationRequest, type Message,
  type ModelCapabilities, type ProviderKey, type RunContext, type SystemDirective,
  type ToolDeclaration,
} from '@salvations/core';

/**
 * Fixed order for system directives.
 *
 * Declared rather than derived from insertion order: two call sites that add
 * memory and retrieval in a different sequence would otherwise produce two
 * different prefixes for the same agent.
 */
const DIRECTIVE_RANK: Readonly<Record<SystemDirective['kind'], number>> = Object.freeze({
  identity: 0,
  policy: 1,
  safety: 2,
  memory: 3,
  retrieval: 4,
});

export interface AssembleInput {
  readonly ctx: Pick<RunContext, 'runId' | 'workspaceId' | 'agentId' | 'providerKey' | 'capabilities'>;
  readonly directives: readonly SystemDirective[];
  /** Full persisted history. Superseded messages are dropped here, not by callers. */
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDeclaration[];
  readonly maxOutputTokens: number;
  readonly toolChoice?: GenerationRequest['toolChoice'];
  readonly structuredOutput?: GenerationRequest['structuredOutput'];
  readonly stopSequences?: readonly string[];
  readonly reasoning?: GenerationRequest['reasoning'];
}

export interface AssembledPrompt {
  readonly request: GenerationRequest;
  /**
   * Digest of the LONG-LIVED prefix — system directives, tools, and history up
   * to the stable anchor.
   *
   * This is the value that must not change from step to step. The trailing
   * breakpoint deliberately advances as history grows (that is how a cache is
   * extended); the anchor does not, and a change in it means a cache entry was
   * thrown away for a reason worth finding rather than a cost worth absorbing.
   */
  readonly prefixFingerprint: string;
  /** One digest per breakpoint, innermost first. */
  readonly prefixFingerprints: readonly string[];
  readonly droppedArtifacts: number;
}

/** Sorts directives into the declared order, keeping relative order within a kind. */
function orderDirectives(
  directives: readonly SystemDirective[],
): readonly SystemDirective[] {
  return directives
    .map((directive, index) => ({ directive, index }))
    .sort((a, b) => {
      const rank = DIRECTIVE_RANK[a.directive.kind] - DIRECTIVE_RANK[b.directive.kind];
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map(({ directive }) => directive);
}

/**
 * Sorts tools by canonical name.
 *
 * The tool array is part of the cacheable prefix on every provider that caches
 * tools at all, and discovery order is not stable — it depends on how many MCP
 * servers answered first.
 */
const orderTools = (tools: readonly ToolDeclaration[]): readonly ToolDeclaration[] =>
  [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * Converts a persisted message for the wire.
 *
 * Provider artifacts are replayed ONLY for the exact model that produced them.
 * Everything else is dropped — replaying foreign reasoning state is rejected by
 * some vendors and silently corrupts continuation on others.
 */
function toCanonical(
  message: Message,
  current: ProviderKey,
): { message: CanonicalMessage; droppedArtifact: boolean } {
  const artifact = artifactsForModel(message.providerArtifacts, current);
  const hadArtifacts =
    message.providerArtifacts !== undefined &&
    Object.keys(message.providerArtifacts).length > 0;

  return {
    message: {
      role: message.role,
      content: message.content,
      ...(artifact !== undefined
        ? { providerArtifacts: { [current]: artifact } }
        : {}),
    },
    droppedArtifact: hadArtifacts && artifact === undefined,
  };
}

/** What the model reads for a tool call the run never answered. */
export const UNANSWERED_TOOL_CALL =
  'This call was not completed: the run ended before it could run. Call it again if the result still matters.';

/**
 * Answers every tool call the history left unanswered.
 *
 * A run can end between the model asking for tools and their results being
 * written: a budget reached in the tool phase, a kill switch, a run that
 * suspended for approval and was then overtaken by a new message. The
 * `tool_use` stays in the conversation, and every provider refuses a history
 * in which one is not answered by the very next message. History is
 * append-only and the gap is real, so it is answered here, at assembly, with
 * an error result that says so, rather than rewritten in the store.
 *
 * The last message is left alone: an unanswered call there is a tool phase
 * still owed, and the runtime runs it before any model call.
 */
export function answerOrphanedToolCalls(messages: CanonicalMessage[]): number {
  let answered = 0;
  for (let i = 0; i < messages.length - 1; i++) {
    const message = messages[i] as CanonicalMessage;
    if (message.role !== 'assistant') continue;
    const asked = toolUseBlocks(message.content).map((block) => block.id);
    if (asked.length === 0) continue;

    const next = messages[i + 1] as CanonicalMessage;
    const given = new Set(
      next.content
        .filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
        .map((block) => block.toolUseId),
    );
    const missing = asked.filter((id) => !given.has(id));
    if (missing.length === 0) continue;

    const results = missing.map((id) =>
      toolResultBlock(id, [textBlock(UNANSWERED_TOOL_CALL)], { isError: true }));
    answered += missing.length;

    if (next.role === 'tool') {
      // Partly answered: the results belong in the message that holds the rest.
      messages[i + 1] = { ...next, content: [...next.content, ...results] };
    } else {
      messages.splice(i + 1, 0, { role: 'tool', content: results });
    }
  }
  return answered;
}

/**
 * How far apart stable anchors are placed, in messages.
 *
 * The trailing breakpoint moves every step — that is how an extending cache
 * works, and each step writes a slightly longer prefix. The ANCHOR must not
 * move, or the entry written under it is never read back. Rounding it down to a
 * stride means it stays put for `CACHE_ANCHOR_STRIDE` steps and is then rewritten
 * once, rather than being rewritten on every step and hit on none.
 */
export const CACHE_ANCHOR_STRIDE = 8;

/**
 * Where the cacheable prefix ends.
 *
 * Everything up to and including an index is expected to be identical next
 * step. The tail — the newest turn and this step's tool results — is not, so a
 * breakpoint after it would cache a prefix that never recurs and pay the
 * cache-write premium for nothing.
 */
function breakpointsFor(
  messageCount: number,
  capabilities: ModelCapabilities,
): readonly number[] {
  if (!capabilities.promptCache.supported) return [];
  if (capabilities.promptCache.strategy !== 'explicit_breakpoints') return [];
  // The last two messages are the volatile tail: the newest turn, and the tool
  // results answering it.
  const stableThrough = messageCount - 3;
  if (stableThrough < 0) return [];

  const max = capabilities.promptCache.maxBreakpoints ?? 1;
  if (max <= 1) return [stableThrough];

  const anchor = Math.floor((stableThrough + 1) / CACHE_ANCHOR_STRIDE) * CACHE_ANCHOR_STRIDE - 1;
  return anchor >= 0 && anchor < stableThrough ? [anchor, stableThrough] : [stableThrough];
}

export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const { ctx } = input;

  const directives = orderDirectives(input.directives)
    // An empty directive contributes nothing but a prefix difference between
    // two agents that should share a cache entry.
    .filter((d) => d.text.trim() !== '');

  const tools = orderTools(input.tools);

  const live = input.messages
    .filter((m) => m.supersededBy === undefined)
    // History is append-only and seq is dense, but the caller's query order is
    // not part of that guarantee.
    .slice()
    .sort((a, b) => a.seq - b.seq);

  let droppedArtifacts = 0;
  const messages: CanonicalMessage[] = [];
  for (const message of live) {
    const converted = toCanonical(message, ctx.providerKey);
    if (converted.droppedArtifact) droppedArtifacts += 1;
    messages.push(converted.message);
  }
  answerOrphanedToolCalls(messages);

  const breakpointsAfter = breakpointsFor(messages.length, ctx.capabilities);

  const request: GenerationRequest = {
    system: directives,
    messages,
    tools,
    toolChoice: input.toolChoice ?? 'auto',
    maxOutputTokens: input.maxOutputTokens,
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    ...(breakpointsAfter.length > 0 ? { cacheHints: { breakpointsAfter } } : {}),
    ...(input.structuredOutput !== undefined ? { structuredOutput: input.structuredOutput } : {}),
    ...(input.stopSequences !== undefined ? { stopSequences: input.stopSequences } : {}),
    metadata: {
      runId: ctx.runId,
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
    },
  };

  const prefixFingerprints = breakpointsAfter.map((through) =>
    prefixFingerprintOf(request, through));

  return {
    request,
    // The anchor when there is one; otherwise the only prefix there is.
    prefixFingerprint: prefixFingerprints[0] ?? fingerprint({
      system: request.system, tools: request.tools, toolChoice: request.toolChoice, messages: [],
    }),
    prefixFingerprints,
    droppedArtifacts,
  };
}

/**
 * Is `before`'s cached prefix still usable against `after`?
 *
 * This is the invariant a prompt cache actually requires, and it is weaker than
 * "the prefix is identical": a cache is EXTENDED every step. What must never
 * happen is MUTATION — a reordered tool, a rewritten directive, an edited
 * message inside the cached region — because that invalidates every entry
 * written so far rather than just adding to them.
 */
export function prefixIsPreserved(before: AssembledPrompt, after: AssembledPrompt): boolean {
  const cached = cachedPrefixOf(before);
  if (cached === undefined) return true;

  if (canonicalJson(before.request.system) !== canonicalJson(after.request.system)) return false;
  if (canonicalJson(before.request.tools) !== canonicalJson(after.request.tools)) return false;
  if (after.request.messages.length < cached.length) return false;

  return canonicalJson(cached) === canonicalJson(after.request.messages.slice(0, cached.length));
}

/** The message slice inside the outermost breakpoint, or undefined if none. */
export function cachedPrefixOf(prompt: AssembledPrompt): readonly CanonicalMessage[] | undefined {
  const through = prompt.request.cacheHints?.breakpointsAfter.at(-1);
  return through === undefined ? undefined : prompt.request.messages.slice(0, through + 1);
}

/**
 * Digests exactly the part that must not change.
 *
 * `metadata` is excluded deliberately: it carries the run id, which differs on
 * every run and is not sent as part of the cached prefix.
 */
export function prefixFingerprintOf(request: GenerationRequest, through: number): string {
  return fingerprint({
    system: request.system,
    tools: request.tools,
    toolChoice: request.toolChoice,
    messages: request.messages.slice(0, through + 1),
  });
}

/** Rough token estimate for compaction thresholds. Deliberately cheap: an exact
 *  count costs a provider round trip, and the threshold is a heuristic anyway. */
export function estimateTokens(content: readonly ContentBlock[]): number {
  let characters = 0;
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'text') characters += block.text.length;
      else if (block.type === 'reasoning') characters += block.summary?.length ?? 0;
      else if (block.type === 'tool_use') characters += JSON.stringify(block.input ?? '').length;
      else if (block.type === 'tool_result') walk(block.content);
      // A blob reference costs only its key; the payload is not in the prompt.
      else if (block.type === 'blob_ref') characters += block.key.length;
    }
  };
  walk(content);
  // ~4 characters per token holds well enough for English prose and JSON alike.
  return Math.ceil(characters / 4);
}
