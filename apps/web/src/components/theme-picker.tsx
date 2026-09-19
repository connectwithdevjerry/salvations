'use client';

import { useEffect, useState } from 'react';

/**
 * Light, dark, or whatever the system says.
 *
 * Stored in the browser, not the account: the same person reasonably wants
 * dark on the laptop they use at night and light on the office monitor. The
 * layout applies the stored choice before first paint; this control changes
 * it live.
 */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'hive.theme';

const OPTIONS: readonly { id: Theme; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Follows your device' },
  { id: 'light', label: 'Light', hint: 'Bright surfaces' },
  { id: 'dark', label: 'Dark', hint: 'The designed default' },
];

export function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked: the choice applies for this page and is not kept.
  }
}

export function ThemePicker() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => { setTheme(readTheme()); }, []);

  return (
    <div className="theme-picker" role="radiogroup" aria-label="Appearance">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={theme === option.id}
          className={theme === option.id ? 'theme-option on' : 'theme-option'}
          onClick={() => { setTheme(option.id); applyTheme(option.id); }}
        >
          <span className={`theme-swatch ${option.id}`} aria-hidden />
          <span>
            <strong>{option.label}</strong>
            <span className="sub">{option.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
