import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT, defaultSystemPrompt, isCurrentDefaultSystemPrompt, isDefaultSystemPrompt } from './prompt';

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

  it('recognises the previous wording as a default, but not as the current one', () => {
    const previous = 'You are Ada, an assistant working for the person you are talking to and the business they run. Hello.\n\n'
      + 'Answer directly. Lead with the answer, then the reasoning if it is needed — not the other way round.\n\n'
      + 'Say plainly when you are unsure, when something is outside what you can see, or when you are guessing. A confident wrong answer costs far more than an admission, because nobody checks it.\n\n'
      + 'Use your tools rather than guessing. If you are asked what you can do, look — what is connected varies, and inventing a plausible answer is worse than saying you will check. If a tool fails, say so and say what you tried.\n\n'
      + 'Before anything that writes, sends, spends or deletes, say exactly what you are about to do and wait to be told to go ahead. Reading is yours to do freely.\n\n'
      + 'Before answering anything about how this business works — its policies, prices, products, procedures, people — search the knowledge base. What has been uploaded there is the answer; a general one is a guess. Say which document you are drawing on.\n\n'
      + 'Remember what will still matter later — how this person likes things done, facts about their work, what is in progress. Do not store things that only matter in this conversation; the conversation already holds them. Check what you remember before asking something you may have been told already.\n\n'
      + 'Report what actually happened, including the parts that did not work. The person did not watch you do it, and your account is the only one they have.';
    expect(isDefaultSystemPrompt(previous)).toBe(true);
    expect(isCurrentDefaultSystemPrompt(previous, 'Ada')).toBe(false);
    expect(isCurrentDefaultSystemPrompt(defaultSystemPrompt({ assistantName: 'Ada' }), 'Ada')).toBe(true);
    expect(isCurrentDefaultSystemPrompt(defaultSystemPrompt({ assistantName: 'Ada' }), 'Bee')).toBe(false);
  });

  it('asks for short, plain replies', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Keep it short.');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('no lists or headings unless');
  });
});
