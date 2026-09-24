'use client';

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

/**
 * The app's own dialogs: a question, a name, a notice.
 *
 * The browser's prompt, confirm and alert are modal in the wrong way — they
 * look like nothing else on the page, cannot be styled, and on some browsers
 * are blocked outright. These sit over the page in the page's own type and
 * colours, take Escape and the backdrop as "no", and Enter as "yes".
 *
 * Each returns a promise, so a caller reads like a sentence:
 *   if (await dialog.confirm({ title: 'Delete this chat?' })) …
 */

interface ConfirmOptions {
  readonly title: string;
  readonly body?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** A red confirm button, for things that cannot be undone. */
  readonly danger?: boolean;
}

interface PromptOptions {
  readonly title: string;
  readonly body?: string;
  readonly label?: string;
  readonly initial?: string;
  readonly placeholder?: string;
  readonly confirmLabel?: string;
  readonly maxLength?: number;
}

interface NoticeOptions {
  readonly title: string;
  readonly body?: string | undefined;
  readonly closeLabel?: string;
}

export interface Dialogs {
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** The trimmed text, or undefined when cancelled or left empty. */
  prompt(options: PromptOptions): Promise<string | undefined>;
  notice(options: NoticeOptions): Promise<void>;
}

type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | undefined) => void }
  | { kind: 'notice'; options: NoticeOptions; resolve: () => void };

const DialogContext = createContext<Dialogs | undefined>(undefined);

export function useDialog(): Dialogs {
  const dialogs = useContext(DialogContext);
  if (dialogs === undefined) throw new Error('useDialog needs a DialogProvider above it.');
  return dialogs;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending>();

  const dialogs = useMemo<Dialogs>(() => ({
    confirm: (options) => new Promise((resolve) => setPending({ kind: 'confirm', options, resolve })),
    prompt: (options) => new Promise((resolve) => setPending({ kind: 'prompt', options, resolve })),
    notice: (options) => new Promise((resolve) => setPending({ kind: 'notice', options, resolve })),
  }), []);

  const close = useCallback(() => setPending(undefined), []);

  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {pending !== undefined && <DialogSurface pending={pending} close={close} />}
    </DialogContext.Provider>
  );
}

function DialogSurface({ pending, close }: { pending: Pending; close: () => void }) {
  const [text, setText] = useState(pending.kind === 'prompt' ? pending.options.initial ?? '' : '');
  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // The thing to type in, or the thing to press, gets focus at once.
  useEffect(() => {
    if (pending.kind === 'prompt') { inputRef.current?.focus(); inputRef.current?.select(); } else primaryRef.current?.focus();
  }, [pending.kind]);

  function cancel() {
    if (pending.kind === 'confirm') pending.resolve(false);
    else if (pending.kind === 'prompt') pending.resolve(undefined);
    else pending.resolve();
    close();
  }

  function accept() {
    if (pending.kind === 'confirm') pending.resolve(true);
    else if (pending.kind === 'prompt') {
      const value = text.trim();
      pending.resolve(value === '' ? undefined : value);
    } else pending.resolve();
    close();
  }

  // Escape cancels whichever dialog is up. The ref keeps the listener on the
  // current one without re-registering it on every render.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const title = pending.options.title;
  const body = pending.options.body;
  const danger = pending.kind === 'confirm' && pending.options.danger === true;
  const confirmLabel = pending.kind === 'notice'
    ? pending.options.closeLabel ?? 'OK'
    : pending.options.confirmLabel ?? (pending.kind === 'prompt' ? 'Save' : 'Confirm');

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <div className="dialog" role={pending.kind === 'notice' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="dialog-title">
        <h3 id="dialog-title">{title}</h3>
        {body !== undefined && <p className="muted">{body}</p>}
        {pending.kind === 'prompt' && (
          <form onSubmit={(event) => { event.preventDefault(); accept(); }}>
            {pending.options.label !== undefined && <label htmlFor="dialog-input">{pending.options.label}</label>}
            <input
              id="dialog-input"
              ref={inputRef}
              value={text}
              maxLength={pending.options.maxLength ?? 120}
              placeholder={pending.options.placeholder ?? ''}
              onChange={(event) => setText(event.target.value)}
            />
          </form>
        )}
        <div className="dialog-actions">
          {pending.kind !== 'notice' && (
            <button type="button" className="ghost" onClick={cancel}>
              {pending.kind === 'confirm' ? pending.options.cancelLabel ?? 'Cancel' : 'Cancel'}
            </button>
          )}
          <button
            ref={primaryRef}
            type="button"
            className={danger ? 'primary danger' : 'primary'}
            disabled={pending.kind === 'prompt' && text.trim() === ''}
            onClick={accept}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
