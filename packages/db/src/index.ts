/**
 * @salvations/db — the ONLY package permitted to import the MongoDB driver.
 *
 * Everything reaches the database through ScopedDb, which is what makes the
 * tenancy guard unavoidable rather than optional.
 */
export * from './collections.js';
export * from './guard.js';
export * from './client.js';
export * from './scoped.js';
export * from './indexes.js';
export * from './documents.js';
export * from './mappers.js';
export * from './run-queue.js';
export * from './repositories/capabilities.js';
export * from './repositories/capability-mapper.js';
export { runMigrations } from './migrate.js';
