/**
 * Something is on its way.
 *
 * A hive, filling: seven cells that light in turn around the centre and fade
 * as the wave passes, in the accent. It is the brand's own mark doing the
 * waiting, rather than a generic ring, and it reads at both sizes — a pane
 * and a line. With reduced motion the cells breathe together, slowly.
 */
export function Loader({ label, inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? 'loader inline' : 'loader'} role="status" aria-live="polite">
      <svg className="loader-hive" viewBox="0 0 100 100" aria-hidden>
        {CELLS.map((cell, index) => (
          <path
            key={index}
            className="loader-cell"
            style={{ animationDelay: `${index * 110}ms` }}
            d={HEX}
            transform={`translate(${cell.x} ${cell.y})`}
          />
        ))}
      </svg>
      {label !== undefined && <span className="loader-label">{label}</span>}
      {label === undefined && <span className="sr-only">Loading</span>}
    </div>
  );
}

/** A pointy-top hexagon 28 wide, 32 tall, anchored at its top-left. */
const HEX = 'M14 0l14 8v16l-14 8L0 24V8z';

/* Centre first, then clockwise from the top — the order the wave lights them. */
const CELLS: readonly { x: number; y: number }[] = [
  { x: 36, y: 34 },
  { x: 36, y: 2 },
  { x: 64, y: 18 },
  { x: 64, y: 50 },
  { x: 36, y: 66 },
  { x: 8, y: 50 },
  { x: 8, y: 18 },
];
