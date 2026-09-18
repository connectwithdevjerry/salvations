/**
 * Cutting a document into pieces an agent can be handed.
 *
 * Paragraphs first. A chunk boundary inside a sentence hands the model half a
 * thought, and a boundary that ignores paragraphs merges a heading with the
 * previous section's last line. So paragraphs are the unit, sentences are the
 * fallback for a paragraph that is too long on its own, and a hard cut is the
 * fallback for a sentence that never ends — a table, a URL list, minified
 * anything.
 *
 * Consecutive chunks overlap, so a fact that straddles a boundary is whole in
 * at least one of them. The cost is a little duplication; the alternative is
 * an answer that is wrong because the relevant sentence was split.
 */

export interface ChunkOptions {
  /** Aim for chunks about this long, in characters. */
  readonly target: number;
  /** How much of the previous chunk's tail starts the next one. */
  readonly overlap: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { target: 1_500, overlap: 200 };

/**
 * The longest chunk `chunkText` can produce under the given options: a piece
 * no longer than the target, the overlap carried in before it, and the blank
 * line between them.
 */
export const maxChunkLength = (options: ChunkOptions): number =>
  options.target + options.overlap + 2;

/**
 * The most chunks one document may have.
 *
 * Retrieval ranks in-process, so this bounds the work a search does. A
 * document beyond it is refused at upload with "split it", which is honest;
 * silently truncating it would store a document that answers questions about
 * its first half only.
 */
export const MAX_CHUNKS_PER_DOCUMENT = 800;

export interface TextChunk {
  readonly index: number;
  readonly content: string;
}

export function chunkText(text: string, options: ChunkOptions = DEFAULT_CHUNKING): TextChunk[] {
  const pieces = paragraphs(text).flatMap((paragraph) => split(paragraph, options.target));
  if (pieces.length === 0) return [];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim() !== '') chunks.push(current.trim());
    // The next chunk begins with the tail of this one, cut at a word boundary
    // so it does not open mid-word.
    current = tail(current, options.overlap);
  };

  for (const piece of pieces) {
    const joined = current === '' ? piece : `${current}\n\n${piece}`;
    if (joined.length > options.target && current.trim() !== '') {
      flush();
      current = current === '' ? piece : `${current}\n\n${piece}`;
    } else {
      current = joined;
    }
  }
  if (current.trim() !== '') chunks.push(current.trim());

  return chunks.map((content, index) => ({ index, content }));
}

/** Non-empty paragraphs, in order. Blank lines are the separator. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

/**
 * A paragraph that fits is one piece. One that does not is cut at sentence
 * ends, and any sentence that still does not fit is cut hard.
 */
function split(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];

  const out: string[] = [];
  let current = '';
  for (const sentence of sentences(paragraph)) {
    for (const part of hardCut(sentence, limit)) {
      const joined = current === '' ? part : `${current} ${part}`;
      if (joined.length > limit && current !== '') {
        out.push(current);
        current = part;
      } else {
        current = joined;
      }
    }
  }
  if (current !== '') out.push(current);
  return out;
}

function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

function hardCut(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // Prefer the last space in the window, so a hard cut still lands between
    // words when there are any.
    const window = rest.slice(0, limit);
    const at = window.lastIndexOf(' ');
    const cut = at > limit / 2 ? at : limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') out.push(rest);
  return out;
}

/** The last `length` characters, starting at a word boundary. */
function tail(text: string, length: number): string {
  if (length <= 0 || text.length <= length) return length <= 0 ? '' : text;
  const window = text.slice(-length);
  const at = window.indexOf(' ');
  return (at === -1 ? window : window.slice(at + 1)).trimStart();
}
