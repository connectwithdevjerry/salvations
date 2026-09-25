/**
 * @salvations/contracts — the API surface, as schemas.
 *
 * Imported by both the routes and the UI. A payload change is therefore a type
 * error on both sides in the same commit, which a hand-written client type can
 * never be.
 */
export * from './common';
export * from './resources';
export * from './events';
