import { describe, expect, it } from 'vitest';
import { memoriesOf, parseIdentity, planImport } from './openclaw-import';

const WORKSPACE = [
  { path: 'backup/workspace/IDENTITY.md', text: '# Identity\n\n- **Name:** Bee\n- **Emoji:** 🐝\n- Vibe: warm, brisk' },
  { path: 'backup/workspace/SOUL.md', text: '# Soul\n\nWarm, brief, never sycophantic.' },
  { path: 'backup/workspace/AGENTS.md', text: '# Rules\n\nCheck the calendar before promising a time.' },
  { path: 'backup/workspace/USER.md', text: 'Ada runs Okoro Trading in Lagos.' },
  { path: 'backup/workspace/MEMORY.md', text: '# Memory\n\n- Ada prefers replies before 9am.\n- Sam handles deliveries.\n\nThe rice supplier is Ojo & Sons, paid net 30.' },
  { path: 'backup/workspace/memory/2026-09-01.md', text: 'Met Sam about the new route.' },
  { path: 'backup/workspace/skills/personal/invoicing/SKILL.md', text: '---\nname: invoicing\n---\nHow to raise an invoice.' },
  { path: 'backup/workspace/HEARTBEAT.md', text: 'Every morning, list today\'s deliveries.' },
  { path: 'backup/workspace/BOOTSTRAP.md', text: 'first run' },
  { path: 'backup/workspace/logo.png', text: '\u0000\u0001' },
  { path: 'backup/openclaw.json', text: '{}' },
  { path: 'backup/workspace/.git/config', text: 'x' },
];

describe('planning an OpenClaw import', () => {
  it('finds the workspace at any depth and names the assistant from IDENTITY.md', () => {
    const plan = planImport(WORKSPACE);
    expect(plan.root).toBe('backup/workspace/');
    expect(plan.name).toBe('Bee');
    expect(plan.emoji).toBe('🐝');
  });

  it('turns soul, rules and user into instructions that still work here', () => {
    const plan = planImport(WORKSPACE);
    expect(plan.systemPrompt.startsWith('You are Bee 🐝, brought here from OpenClaw.')).toBe(true);
    expect(plan.systemPrompt).toContain('## Who you are\n\n# Soul\n\nWarm, brief, never sycophantic.');
    expect(plan.systemPrompt).toContain('Check the calendar before promising a time.');
    expect(plan.systemPrompt).toContain('Ada runs Okoro Trading');
    expect(plan.systemPrompt).toContain('never use an em-dash');
  });

  it('makes memories of the curated memory file, one per fact', () => {
    expect(planImport(WORKSPACE).memories).toEqual([
      'Ada prefers replies before 9am.',
      'Sam handles deliveries.',
      'The rice supplier is Ojo & Sons, paid net 30.',
    ]);
  });

  it('makes documents of daily notes and skills, keeps the heartbeat, and says what it left out', () => {
    const plan = planImport(WORKSPACE);
    expect(plan.documents.map((d) => d.title)).toEqual(['Notes 2026-09-01', 'Skill: invoicing']);
    expect(plan.heartbeat).toBe('Every morning, list today\'s deliveries.');
    expect(plan.skipped).toEqual([
      { path: 'logo.png', reason: 'not a text file' },
      { path: 'BOOTSTRAP.md', reason: 'a first-run or startup ritual, not needed here' },
    ]);
  });

  it('refuses an archive with no workspace in it', () => {
    expect(() => planImport([{ path: 'notes.txt', text: 'hi' }])).toThrow('No OpenClaw workspace found');
  });

  it('reads a name from a heading when there is no name line', () => {
    expect(parseIdentity('# Bee\n\nJust Bee.')).toEqual({ name: 'Bee' });
    expect(parseIdentity('')).toEqual({});
  });

  it('splits memory on bullets, numbers and paragraphs and drops headings', () => {
    expect(memoriesOf('# Facts\n1. One thing here.\n2. Another thing.\n\nA paragraph fact.')).toEqual([
      'One thing here.', 'Another thing.', 'A paragraph fact.',
    ]);
  });
});
