'use client';

import { useEffect, useState } from 'react';

/**
 * One word in a sentence that cycles through a list.
 *
 * The first word is in the HTML, so the sentence reads whole before any
 * script runs and reads whole to anything that runs none. From then on the
 * word changes every few seconds, each one rising in as the last one goes.
 * Somebody who asked their system for less motion gets the swap without
 * the movement.
 */
export function RotatingWord({ words, every = 2400, className }: {
  readonly words: readonly string[];
  readonly every?: number;
  readonly className?: string;
}) {
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (words.length < 2) return undefined;
    let swap: ReturnType<typeof setTimeout> | undefined;
    const tick = setInterval(() => {
      setLeaving(true);
      swap = setTimeout(() => {
        setIndex((i) => (i + 1) % words.length);
        setLeaving(false);
      }, 260);
    }, every);
    return () => { clearInterval(tick); if (swap !== undefined) clearTimeout(swap); };
  }, [words, every]);

  const word = words[index] ?? words[0] ?? '';
  return (
    <span className={`rotating-word${leaving ? ' out' : ''}${className === undefined ? '' : ` ${className}`}`} aria-live="off">
      <span className="rotating-word-text" key={word}>{word}</span>
    </span>
  );
}
