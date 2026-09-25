import { Fragment, type ReactNode } from 'react';

/**
 * The little markdown an answer actually uses.
 *
 * Paragraphs, bullet lists, fenced code, inline code and bold — rendered
 * from text, never from HTML, so nothing an assistant (or a tool result it
 * quotes) writes can become markup. Anything else stays as typed.
 */
export function RichText({ text }: { text: string }) {
  return <>{blocks(text).map((block, i) => <Fragment key={i}>{block}</Fragment>)}</>;
}

function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) { code.push(lines[i] ?? ''); i += 1; }
      i += 1;
      out.push(<pre className="rt-code"><code>{code.join('\n')}</code></pre>);
      continue;
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*•]\s+/, ''));
        i += 1;
      }
      out.push(<ul className="rt-list">{items.map((item, k) => <li key={k}>{inline(item)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      out.push(<ol className="rt-list">{items.map((item, k) => <li key={k}>{inline(item)}</li>)}</ol>);
      continue;
    }

    if (line.trim() === '') { i += 1; continue; }

    // A paragraph runs until a blank line or something structural.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (l.trim() === '' || l.startsWith('```') || /^\s*[-*•]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) break;
      para.push(l);
      i += 1;
    }
    out.push(<p className="rt-p">{para.map((l, k) => <Fragment key={k}>{k > 0 && <br />}{inline(l)}</Fragment>)}</p>);
  }
  return out;
}

/** Bold and inline code. Nothing else, so nothing surprising. */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const token = match[0];
    if (token.startsWith('`')) parts.push(<code key={at} className="rt-inline">{token.slice(1, -1)}</code>);
    else parts.push(<strong key={at}>{token.slice(2, -2)}</strong>);
    last = at + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
