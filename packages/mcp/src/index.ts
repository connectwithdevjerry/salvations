/**
 * The MCP layer's public surface.
 *
 * `@modelcontextprotocol/*` is imported nowhere else in the repository
 * (invariant I5): everything above this package sees our own types, so a
 * protocol revision stays a change to this package alone.
 */
export {
  CLIENT_INFO, McpClientManager, UnsupportedTransportError, createClient,
  type BindingHealth, type ConnectOptions, type ConnectedClient, type McpServerDefinition,
  type McpTransportKind,
} from './client';

export {
  ToolGateway,
  type GatewayDeps, type GatewayPrincipal, type InvocationContext, type PermissionOutcome,
  type ToolOutcome,
} from './gateway';

export {
  CapabilityDiscovery,
  type DiscoveryOptions, type DiscoveryOutcome,
} from './discovery';

export {
  BindingUnavailableError, MAX_TOOL_TIMEOUT_MS, McpServerRegistry, effectiveMrtrPolicy,
  type BindingRecord, type BindingSource, type BindingStatus, type ConnectionAuthSource,
  type ResolvedBinding, type ServerRecord,
} from './registry';

export {
  DEFAULT_MRTR_POLICY, classifyInputRequest, classifyInputRequests, decideMrtr, isInputRequired,
  requestStateFingerprint,
  type ClassifiedInputRequest, type InputRequestKind, type MrtrContinuation, type MrtrDecision,
  type MrtrPolicy,
} from './mrtr';

export {
  MAX_ACCEPTED_RESULT_BYTES, MAX_INLINE_RESULT_BYTES, normaliseToolResult, refusalResult,
  type NormalisedResult, type NormaliseOptions,
} from './results';

export { SchemaValidator, type ValidationResult } from './validation';

export {
  CircuitBreaker, CircuitOpenError, DEFAULT_TOOL_TIMEOUT_MS, Semaphore, ToolTimeoutError,
  withTimeout, type CircuitOptions, type CircuitState,
} from './resilience';

export {
  MAX_TTL_MS, ScopedResponseCache, cacheKeyFor, clampTtl, isShareableAcrossUsers,
  parseCacheScope, type CacheScope,
} from './cache';

export {
  capabilityScopeKey, scopeFor, scopeKeyString, userScope, workspaceScope,
  type ConnectionScopeKey,
} from './scope';
