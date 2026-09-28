/**
 * Turning a workspace folder from another assistant into an assistant here.
 *
 * The format is the one self-hosted assistants use: a folder of Markdown: who it is (IDENTITY.md), how
 * it speaks (SOUL.md), how it works (AGENTS.md), who it works for
 * (USER.md), what it remembers (MEMORY.md and memory/*.md) and what it
 * can do (skills/). Every one of those has a home here. The persona and
 * rules become the assistant's instructions; the curated memory becomes
 * memories; the daily logs, skills and other notes become documents it
 * can search; a heartbeat becomes a routine.
 *
 * Pure: files in, a plan out. The route decides what to write.
 */

export interface ImportFile {
  readonly path: string;
  readonly text: string;
}

export interface ImportPlan {
  readonly name: string;
  readonly emoji?: string;
  /** Where in the archive the workspace was found. */
  readonly root: string;
  readonly systemPrompt: string;
  readonly memories: readonly string[];
  readonly documents: readonly { title: string; fileName: string; text: string }[];
  readonly heartbeat?: string;
  /** What was seen and left out, and why, so nothing vanishes quietly. */
  readonly skipped: readonly { path: string; reason: string }[];
}

const CORE = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md', 'BOOT.md', 'BOOTSTRAP.md', 'DREAMS.md'] as const;
const MARKERS = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'MEMORY.md'];

/** Instructions beyond this are cut, with a note; a prompt is read on every turn. */
export const MAX_PROMPT_CHARS = 24_000;
export const MAX_MEMORY_CHARS = 600;
export const MAX_MEMORIES = 300;
export const MAX_DOCUMENTS = 200;

export function planImport(files: readonly ImportFile[], fallbackName = 'Imported assistant'): ImportPlan {
  const root = findRoot(files);
  if (root === undefined) {
    throw new Error('No assistant workspace found. The archive should hold SOUL.md, AGENTS.md or MEMORY.md, at any depth.');
  }
  const inRoot = files
    .filter((f) => f.path.startsWith(root))
    .map((f) => ({ path: f.path.slice(root.length), text: f.text }))
    .filter((f) => !f.path.split('/').some((part) => part.startsWith('.')));

  const read = (name: string) => inRoot.find((f) => f.path === name)?.text;
  const identity = parseIdentity(read('IDENTITY.md') ?? '');
  const name = (identity.name ?? fallbackName).slice(0, 80);

  const skipped: { path: string; reason: string }[] = [];
  const documents: { title: string; fileName: string; text: string }[] = [];
  const memories = memoriesOf(read('MEMORY.md') ?? '');

  for (const file of inRoot) {
    if ((CORE as readonly string[]).includes(file.path)) continue;
    if (!/\.(md|markdown|txt)$/i.test(file.path)) { skipped.push({ path: file.path, reason: 'not a text file' }); continue; }
    if (file.text.trim() === '') { skipped.push({ path: file.path, reason: 'empty' }); continue; }
    if (documents.length >= MAX_DOCUMENTS) { skipped.push({ path: file.path, reason: 'document limit reached' }); continue; }
    documents.push({ title: titleFor(file), fileName: file.path.split('/').pop() ?? file.path, text: file.text });
  }
  for (const name of ['TOOLS.md', 'DREAMS.md'] as const) {
    const text = read(name);
    if (text !== undefined && text.trim() !== '') documents.push({ title: name === 'TOOLS.md' ? 'Tools and environment (imported)' : 'Dream diary (imported)', fileName: name, text });
  }
  for (const name of ['BOOT.md', 'BOOTSTRAP.md'] as const) {
    if (read(name) !== undefined) skipped.push({ path: name, reason: 'a first-run or startup ritual, not needed here' });
  }

  const heartbeat = (read('HEARTBEAT.md') ?? '').trim();
  const prompt = composePrompt({ name, identity, soul: read('SOUL.md'), agents: read('AGENTS.md'), user: read('USER.md') });

  return {
    name,
    ...(identity.emoji !== undefined ? { emoji: identity.emoji } : {}),
    root,
    systemPrompt: prompt,
    memories,
    documents,
    ...(heartbeat !== '' && !isTemplate(heartbeat) ? { heartbeat } : {}),
    skipped,
  };
}

/** The directory that holds the workspace files: the shallowest one with a marker in it. */
function findRoot(files: readonly ImportFile[]): string | undefined {
  const candidates = files
    .filter((f) => MARKERS.includes(f.path.split('/').pop() ?? ''))
    .map((f) => f.path.slice(0, f.path.lastIndexOf('/') + 1));
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
}

export function parseIdentity(raw: string): { name?: string; emoji?: string } {
  const out: { name?: string; emoji?: string } = {};
  // Bold and underscores are decoration on these lines, never meaning.
  const text = raw.replace(/[*_]/g, '');
  const named = /^\s*-?\s*name\s*[:=]\s*(.+?)\s*$/im.exec(text);
  if (named !== null) out.name = clean(named[1] ?? '');
  else {
    const heading = /^#\s+(.+?)\s*$/m.exec(text);
    if (heading !== null) out.name = clean(heading[1] ?? '');
  }
  const emoji = /^\s*-?\s*emoji\s*[:=]\s*(\S+)/im.exec(text);
  if (emoji !== null && emoji[1] !== undefined) out.emoji = emoji[1];
  if (out.name === '' || out.name === undefined) delete out.name;
  return out;
}

const clean = (s: string): string => s.replace(/[*_`"']/g, '').replace(/\s+/g, ' ').trim();

/** Curated memory, one fact per bullet or paragraph, short enough to be one memory. */
export function memoriesOf(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n(?=\s*(?:[-*+]\s|\d+[.)]\s|#))|\n{2,}/)) {
    const line = block.replace(/^#+\s*/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim();
    if (line.length < 8) continue;
    if (/^(memory|notes?|facts?|decisions?|long[- ]term memory)$/i.test(line)) continue;
    out.push(line.length > MAX_MEMORY_CHARS ? `${line.slice(0, MAX_MEMORY_CHARS - 1)}…` : line);
    if (out.length >= MAX_MEMORIES) break;
  }
  return out;
}

function titleFor(file: { path: string }): string {
  const base = file.path.split('/').pop() ?? file.path;
  if (/^skills\//i.test(file.path) && /SKILL\.md$/i.test(base)) {
    const folder = file.path.split('/').slice(-2, -1)[0] ?? 'skill';
    return `Skill: ${folder}`;
  }
  if (/^memory\//i.test(file.path)) return `Notes ${base.replace(/\.md$/i, '')}`;
  return base.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ');
}

function composePrompt(input: {
  name: string;
  identity: { emoji?: string | undefined };
  soul: string | undefined;
  agents: string | undefined;
  user: string | undefined;
}): string {
  const parts: string[] = [
    `You are ${input.name}${input.identity.emoji === undefined ? '' : ` ${input.identity.emoji}`}, brought here from your previous setup. What follows is who you were there, and it still holds. Where it refers to files, shell commands or tools you no longer have, use the tools you have here instead, and say so when something is not possible any more.`,
  ];
  const section = (title: string, text: string | undefined) => {
    const body = (text ?? '').trim();
    if (body === '' || isTemplate(body)) return;
    parts.push(`## ${title}\n\n${body}`);
  };
  section('Who you are', input.soul);
  section('How you work', input.agents);
  section('Who you work for', input.user);
  parts.push('Keep replies short and plain, and never use an em-dash. Before anything that writes, sends, spends or deletes, say what you are about to do and wait to be told to go ahead.');
  let prompt = parts.join('\n\n');
  if (prompt.length > MAX_PROMPT_CHARS) prompt = `${prompt.slice(0, MAX_PROMPT_CHARS)}\n\n(Instructions were cut here to fit.)`;
  return prompt;
}

/** OpenClaw's untouched templates say so in their own words; an unedited one adds nothing. */
const isTemplate = (text: string): boolean =>
  /fill (this|me) in|replace this|<your /i.test(text) && text.length < 600;
