import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT, defaultSystemPrompt, isDefaultSystemPrompt } from './prompt';

describe('the default prompt', () => {
  it('names the assistant and the business, and tells it to introduce itself from the knowledge base', () => {
    const prompt = defaultSystemPrompt({ assistantName: 'Ada', businessName: 'Okoro Trading' });
    expect(prompt.startsWith('You are Ada, the assistant of Okoro Trading.')).toBe(true);
    expect(prompt).toContain('introduce yourself by name');
    expect(prompt).toContain('knowledge base');
    expect(prompt).toContain('rather than inventing a description');
  });

  it('still reads when the workspace has no name', () => {
    expect(defaultSystemPrompt({ assistantName: 'Ada' }).startsWith('You are Ada, an assistant')).toBe(true);
  });

  it('recognises a default for any name, and the default from before names, but not an edit', () => {
    expect(isDefaultSystemPrompt(defaultSystemPrompt({ assistantName: 'Ada', businessName: 'Okoro' }))).toBe(true);
    expect(isDefaultSystemPrompt(DEFAULT_SYSTEM_PROMPT)).toBe(true);
    expect(isDefaultSystemPrompt('You are a capable assistant working on behalf of the person you are talking to.\n\n' + DEFAULT_SYSTEM_PROMPT.split('\n\n').slice(1).join('\n\n'))).toBe(true);
    expect(isDefaultSystemPrompt(`${defaultSystemPrompt({ assistantName: 'Ada' })}\n\nAlways answer in French.`)).toBe(false);
    expect(isDefaultSystemPrompt('Be terse.')).toBe(false);
  });
});
