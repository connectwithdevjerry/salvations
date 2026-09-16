/**
 * @salvations/db — the ONLY package permitted to import the MongoDB driver.
 *
 * Everything reaches the database through ScopedDb, which is what makes the
 * tenancy guard unavoidable rather than optional.
 */
export * from './collections';
export * from './guard';
export * from './client';
export * from './scoped';
export * from './indexes';
export * from './documents';
export * from './mappers';
export * from './run-queue';
export * from './event-bus';
export * from './repositories/capabilities';
export * from './repositories/capability-mapper';
export * from './repositories/workspaces';
export * from './repositories/api-keys';
export * from './repositories/policies';
export * from './services/permission-broker';
export * from './repositories/conversations';
export * from './repositories/message-mapper';
export * from './repositories/runs';
export * from './repositories/credentials';
export * from './repositories/catalog';
export * from './repositories/telemetry';
export * from './validators';
export * from './atlas-roles';
export { seed, runSeed, SEED_WORKSPACE_ID, SEED_USER_ID } from './seed';
export { runMigrations } from './migrate';
