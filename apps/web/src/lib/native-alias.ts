/**
 * Aliases for an app connected more than once.
 *
 * An alias prefixes every tool name, so two Google accounts on one assistant
 * are `google_workspace__search_mail` and `google_workspace_2__search_mail`:
 * distinct to the model, and still recognisably the same app to the opener,
 * which decides what to build from the alias alone.
 */

/** Whether an alias names a native app: the alias itself, or it with a suffix. */
export const nativeAliasMatches = (alias: string, native: string): boolean =>
  alias === native || alias.startsWith(`${native}_`);

/**
 * The first free alias for a base: the base itself, then `_2`, `_3` and on.
 *
 * Numbered rather than taken from the account's label: a label is for
 * people and may change, and an alias is in every stored tool name.
 */
export function nextAlias(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1_000; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`No free alias for ${base}.`);
}
