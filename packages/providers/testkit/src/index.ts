/**
 * @salvations/provider-testkit — the shared conformance suite.
 *
 * Vendor-neutral by construction: it names no provider, and every assertion is
 * about canonical behaviour. Each adapter supplies its own wire fixtures.
 */
export * from './contract';
export * from './collect';
export { runConformanceSuite } from './suite';
