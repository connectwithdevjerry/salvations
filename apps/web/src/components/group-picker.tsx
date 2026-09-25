'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui';

/**
 * Which group an assistant sits in.
 *
 * A real dropdown rather than a text field with suggestions: the groups
 * that exist are the likely answer and should be one click, "no group" is a
 * proper choice rather than an empty box, and a new group is typed at the
 * bottom of the same list — not somewhere else — so making one and choosing
 * one are the same gesture.
 */
export function GroupPicker({
  value, groups, onChange, id,
}: {
  value: string;
  groups: readonly string[];
  onChange: (next: string) => void;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  // Groups already in use, plus the one being chosen if it is new to the list.
  const options = [...new Set([...groups, ...(value !== '' ? [value] : [])])];

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setDraft('');
    setOpen(false);
  };

  const add = () => {
    const name = draft.trim();
    if (name === '') return;
    choose(name);
  };

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        id={id}
        className={open ? 'picker-field open' : 'picker-field'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={value === '' ? 'picker-value muted' : 'picker-value'}>
          {value === '' ? 'No group' : value}
        </span>
        <Icon name="chevron" size={15} />
      </button>

      {open && (
        <div className="picker-menu" role="listbox" aria-label="Group">
          <button
            type="button" role="option" aria-selected={value === ''}
            className={value === '' ? 'picker-option on' : 'picker-option'}
            onClick={() => choose('')}
          >
            <span>No group</span>
            {value === '' && <Icon name="check" size={14} />}
          </button>

          {options.length > 0 && <div className="picker-rule" />}

          {options.map((group) => (
            <button
              key={group} type="button" role="option" aria-selected={value === group}
              className={value === group ? 'picker-option on' : 'picker-option'}
              onClick={() => choose(group)}
            >
              <span>{group}</span>
              {value === group && <Icon name="check" size={14} />}
            </button>
          ))}

          <div className="picker-rule" />
          <div className="picker-new">
            <Icon name="plus" size={14} />
            <input
              ref={field}
              aria-label="New group"
              placeholder="New group…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); add(); }
              }}
            />
            {draft.trim() !== '' && (
              <button type="button" className="primary" onClick={add}>Add</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
