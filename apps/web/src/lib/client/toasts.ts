/**
 * The notifications channel: anything on the client may announce, and the one
 * `<Toaster />` in the root layout shows what is announced.
 *
 * Kept apart from the component so the request layer can announce a refusal
 * without importing React.
 */

export interface ToastLink { readonly label: string; readonly href: string; readonly external?: boolean }
export interface ToastInput {
  readonly tone?: 'error' | 'info';
  readonly title: string;
  readonly body?: string;
  readonly links?: readonly ToastLink[];
}
export interface Toast extends ToastInput { readonly id: number }

const listeners = new Set<(toast: Toast) => void>();
let nextId = 1;

export function toast(input: ToastInput): void {
  const shown: Toast = { ...input, id: nextId++ };
  for (const listener of listeners) listener(shown);
}

/** For the Toaster: hear every announcement until the returned function is called. */
export function onToast(listener: (toast: Toast) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
