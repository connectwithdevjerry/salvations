/**
 * Something is on its way.
 *
 * One loader everywhere, so waiting looks the same on every page: a ring
 * and, when it helps, a word about what is coming. Centred in whatever it
 * is given, which is usually the whole pane.
 */
export function Loader({ label, inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? 'loader inline' : 'loader'} role="status" aria-live="polite">
      <span className="loader-ring" aria-hidden />
      {label !== undefined && <span className="loader-label">{label}</span>}
      {label === undefined && <span className="sr-only">Loading</span>}
    </div>
  );
}
