import { describe, expect, it } from 'vitest';
import { CORE_ROLE_IDS, DROP_AND_GO, ROLES, dropAndGoFor, roleById, roleSystemPrompt } from './roles';
import { isDefaultSystemPrompt } from './prompt';

describe('the team', () => {
  it('has distinct ids and names, and a starter team of five', () => {
    expect(new Set(ROLES.map((r) => r.id)).size).toBe(ROLES.length);
    expect(new Set(ROLES.map((r) => r.name)).size).toBe(ROLES.length);
    expect(CORE_ROLE_IDS).toEqual(['manager', 'marketing', 'sales', 'support', 'personal']);
    for (const role of ROLES) {
      expect(role.starters).toHaveLength(3);
      expect(role.duties.length).toBeGreaterThan(100);
      // Every role says what a bare drop means for it: a link, a name, a photo.
      expect(role.dropAndGo.length).toBeGreaterThan(80);
    }
  });

  it('owes an older assistant the drop-and-go rule, with its role\'s examples', () => {
    const old = 'You are Finance, the assistant of Okoro Trading.\n\n## Your role: Finance\n\nYou look after the money side.';
    const extra = dropAndGoFor(old);
    expect(extra).toContain(DROP_AND_GO);
    expect(extra).toContain('receipt');
    // A new assistant already carries it.
    const fresh = roleSystemPrompt(roleById('finance')!, { assistantName: 'Finance', businessName: 'Okoro Trading' });
    expect(dropAndGoFor(fresh)).toBeUndefined();
    // No role heading: the shared rule alone.
    expect(dropAndGoFor('You are a helpful assistant.')).toBe(DROP_AND_GO);
  });

  it('writes the role under the identity and above the shared conduct', () => {
    const marketing = roleById('marketing')!;
    const prompt = roleSystemPrompt(marketing, { assistantName: 'Marketing', businessName: 'Okoro Trading' });
    expect(prompt.startsWith('You are Marketing, the assistant of Okoro Trading.')).toBe(true);
    expect(prompt).toContain('## Your role: Marketing');
    expect(prompt).toContain('Keep it short.');
    // A role prompt is a choice somebody made, so it is never treated as an unedited default.
    expect(isDefaultSystemPrompt(prompt)).toBe(false);
  });
});
