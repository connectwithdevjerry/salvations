/**
 * @salvations/core — the pure domain.
 *
 * Entities, ports and policy. No I/O, no driver, no SDK, no deployment platform.
 * The only runtime dependency permitted here is zod.
 */
export * from './ids';
export * from './errors';

export * from './entities/conversation';
export * from './entities/model';
export * from './entities/run';
export * from './entities/principal';
export * from './entities/mcp';

export * from './policy/pattern';
export * from './policy/permission';
export * from './policy/budget';

export * from './ports/index';
