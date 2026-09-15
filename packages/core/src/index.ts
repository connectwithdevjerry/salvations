/**
 * @salvations/core — the pure domain.
 *
 * Entities, ports and policy. No I/O, no driver, no SDK, no deployment platform.
 * The only runtime dependency permitted here is zod.
 */
export * from './ids.js';
export * from './errors.js';

export * from './entities/conversation.js';
export * from './entities/model.js';
export * from './entities/run.js';
export * from './entities/principal.js';
export * from './entities/mcp.js';

export * from './policy/pattern.js';
export * from './policy/permission.js';
export * from './policy/budget.js';

export * from './ports/index.js';
