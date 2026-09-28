import { describe, expect, it } from 'vitest';
import { CORE_ROLE_IDS, ROLES, roleById, roleSystemPrompt } from './roles';
import { isDefaultSystemPrompt } from './prompt';

describe('the team', () => {
  it('has distinct ids and names, and a starter team of five', () => {
    expect(new Set(ROLES.map((r) => r.id)).size).toBe(ROLES.length);
    expect(new Set(ROLES.map((r) => r.name)).size).toBe(ROLES.length);
    expect(CORE_ROLE_IDS).toEqual(['manager', 'marketing', 'sales', 'support', 'personal']);
    for (const role of ROLES) {
      expect(role.starters).toHaveLength(3);
      expect(role.duties.length).toBeGreaterThan(100);
    }
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
