'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { Icon } from '@/components/ui';

/**
 * A password box with an eye at its right end that shows what was typed.
 *
 * Hidden by default. Showing it is the person's choice, per box, and lasts
 * until they hide it again or leave the page; nothing is remembered.
 */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-input">
      <input {...props} type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="password-eye"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        {...(props.id !== undefined ? { 'aria-controls': props.id } : {})}
      >
        <Icon name={shown ? 'eye-off' : 'eye'} size={18} />
      </button>
    </div>
  );
}
