/**
 * Which tools the model is shown.
 *
 * Two filters, in this order: what the AGENT was configured to use, and what the
 * PRINCIPAL is permitted to call. The gateway applies the second — it owns
 * permissions — so this module owns the first and the arithmetic the model's own
 * limits impose.
 *
 * Nothing here is a security boundary. A tool withheld here is a tool the model
 * will not think to call; a tool that must not be called is stopped at the
 * gateway, which is the only thing standing between an argument and a side
 * effect.
 */
import {
  buildToolNameMap,
  type AgentCapabilityBinding, type AgentSnapshot, type ModelCapabilities,
  type ToolDeclaration, type ToolNameMap,
} from '@salvations/core';

export interface SelectionInput {
  readonly available: readonly ToolDeclaration[];
  readonly snapshot: AgentSnapshot;
  readonly capabilities: ModelCapabilities;
  /**
   * Alias → binding id, for the bindings behind `available`.
   *
   * Required, because the two identifiers are genuinely different: a canonical
   * tool name carries the workspace's ALIAS, while an agent attaches to binding
   * IDS. Matching one against the other silently admits nothing, and an agent
   * with no tools looks like a model that chose not to use any.
   */
  readonly bindingIdByAlias: ReadonlyMap<string, string>;
}

export interface Selection {
  readonly tools: readonly ToolDeclaration[];
  /** Canonical ⇄ vendor-legal names. The runtime always speaks canonical. */
  readonly nameMap: ToolNameMap;
  /** Tools the agent's own configuration excluded. */
  readonly excludedByAgent: readonly string[];
  /** Tools dropped because the model cannot be shown that many. */
  readonly droppedForLimit: readonly string[];
}

/** `<alias>__<tool>` — the alias identifies which binding a name came from. */
const aliasOf = (canonicalName: string): string => {
  const index = canonicalName.indexOf('__');
  return index <= 0 ? '' : canonicalName.slice(0, index);
};

const toolNameOf = (canonicalName: string): string => {
  const index = canonicalName.indexOf('__');
  return index <= 0 ? canonicalName : canonicalName.slice(index + 2);
};

/**
 * Applies one binding's mode.
 *
 * `allow` with an empty list means nothing, not everything. A configuration
 * someone saved half-finished should expose no tools rather than all of them.
 */
function bindingAdmits(binding: AgentCapabilityBinding, toolName: string): boolean {
  switch (binding.mode) {
    case 'all': return true;
    case 'allow': return binding.tools.includes(toolName);
    case 'deny': return !binding.tools.includes(toolName);
  }
}

export function selectCapabilities(input: SelectionInput): Selection {
  const { available, snapshot, capabilities } = input;

  if (!capabilities.tools.supported) {
    return {
      tools: [],
      nameMap: buildToolNameMap([], capabilities.tools),
      excludedByAgent: available.map((t) => t.name),
      droppedForLimit: [],
    };
  }

  const byBindingId = new Map<string, AgentCapabilityBinding>();
  for (const binding of snapshot.capabilityBindings) {
    byBindingId.set(String(binding.bindingId), binding);
  }

  const bindingFor = (alias: string): AgentCapabilityBinding | undefined => {
    const bindingId = input.bindingIdByAlias.get(alias);
    return bindingId === undefined ? undefined : byBindingId.get(bindingId);
  };

  const admitted: ToolDeclaration[] = [];
  const excludedByAgent: string[] = [];

  for (const tool of available) {
    const binding = bindingFor(aliasOf(tool.name));
    // A tool from a binding this agent is not attached to is not this agent's
    // tool, however available it is to the workspace.
    if (binding === undefined || !bindingAdmits(binding, toolNameOf(tool.name))) {
      excludedByAgent.push(tool.name);
      continue;
    }
    admitted.push(tool);
  }

  // Deterministic before truncation: a limit applied to an unordered list would
  // show the model a different set of tools each step, which breaks the prompt
  // cache and makes behaviour irreproducible.
  admitted.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const max = capabilities.tools.maxTools;
  const droppedForLimit: string[] = [];
  let tools: ToolDeclaration[] = admitted;
  if (max !== undefined && admitted.length > max) {
    tools = admitted.slice(0, max);
    droppedForLimit.push(...admitted.slice(max).map((t) => t.name));
  }

  return {
    tools,
    nameMap: buildToolNameMap(tools.map((t) => t.name), capabilities.tools),
    excludedByAgent,
    droppedForLimit,
  };
}
