/**
 * The catalogue.
 *
 * Everything HIVE connects to, named. Two lists because they answer different
 * questions — a channel is where you talk to your agent, an integration is what
 * your agent can touch — and a single merged list makes people hunt.
 */
export * from './types';
export { CHANNELS } from './channels';
export { INTEGRATIONS } from './integrations';

import type { CatalogEntry } from './types';
import { CHANNELS } from './channels';
import { INTEGRATIONS } from './integrations';

export const CATALOG: readonly CatalogEntry[] = [...CHANNELS, ...INTEGRATIONS];

const BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(CATALOG.map((e) => [e.id, e]));

/**
 * Looks an entry up.
 *
 * Returns undefined rather than throwing: the id can arrive from a stored row
 * written by an older version, and a catalogue entry that has since been
 * removed should degrade to "unknown connection", not to a crash on the
 * integrations page.
 */
export const catalogEntry = (id: string): CatalogEntry | undefined => BY_ID.get(id);

export const isCatalogId = (id: string): boolean => BY_ID.has(id);

/** Free-text match over the fields a person would actually search by. */
export function searchCatalog(
  entries: readonly CatalogEntry[],
  query: string,
): readonly CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return entries;
  return entries.filter((entry) =>
    `${entry.name} ${entry.summary} ${entry.id}`.toLowerCase().includes(needle));
}
