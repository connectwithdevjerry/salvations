/**
 * The small shared vocabulary: a mark, a set of icons, a progress indicator and
 * a disclosure row.
 *
 * Icons are inline SVG rather than a package. There are eleven of them, and an
 * icon library is a dependency, a bundle and a licence in exchange for glyphs
 * that fit in this file.
 */
import type { ReactNode } from 'react';
import { AntMark } from '@/components/ant-mark';

export type IconName =
  | 'spark' | 'plug' | 'key' | 'agent' | 'server' | 'shield'
  | 'chat' | 'check' | 'chevron' | 'arrow' | 'exit' | 'gear' | 'pulse' | 'clock'
  | 'book' | 'search' | 'plus' | 'mic' | 'trash' | 'pencil' | 'help' | 'grid';

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  spark: <path d="M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7L12 3z" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  pencil: <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3" />,
  grid: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5V14M12 17h.01" />
    </>
  ),
  plug: <path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9zM12 18v3" />,
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3M15.5 12v2" />
    </>
  ),
  agent: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 14h.01M15 14h.01" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  shield: <path d="M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6l7-3z" />,
  chat: <path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-5.5A7 7 0 0 1 11 5h2a7 7 0 0 1 7 7z" />,
  check: <path d="M4 12.5l5 5L20 6.5" />,
  chevron: <path d="M6 15l6-6 6 6" />,
  arrow: <path d="M4 12h15M13 6l6 6-6 6" />,
  exit: <path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  pulse: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  search: <path d="M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16 16l4 4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  mic: <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />,
  book: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15zM4 20.5A2.5 2.5 0 0 0 6.5 18H20v3H6.5M9 7h7" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The tinted square that carries an icon, used for brand, section and option. */
export function Tile({ name, large = false }: { name: IconName; large?: boolean }) {
  return (
    <span className={large ? 'tile lg' : 'tile'}>
      <Icon name={name} size={large ? 22 : 17} />
    </span>
  );
}

export function BrandMark({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <span className="brand">
      <span className="tile brand-tile" aria-hidden>
        <AntMark size={24} />
      </span>
      {wordmark && (
        <span className="wordmark">
          HIVE
          <span className="byline">by Yashayah</span>
        </span>
      )}
    </span>
  );
}

/**
 * Where you are in a sequence.
 *
 * Labelled for a screen reader rather than left as decoration: the dots are the
 * only thing on the page that says how much is left.
 */
export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="step-dots" role="group" aria-label={`Step ${current + 1} of ${total}`}>
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={`dot${index === current ? ' current' : index < current ? ' done' : ''}`}
        />
      ))}
    </div>
  );
}

/**
 * A choice that can open to hold its own form.
 *
 * `open` is controlled by the caller because these are mutually exclusive in
 * every place they are used — opening one closes the rest, and a component that
 * owned its own state could not enforce that.
 */
export function Option({
  icon, title, subtitle, badge, open, onToggle, children,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  badge?: string;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={open ? 'option open' : 'option'}>
      <button type="button" className="option-head" aria-expanded={open} onClick={onToggle}>
        <span className="tile" aria-hidden style={{ width: 28, height: 28, borderRadius: 8 }}>
          <Icon name={icon} size={15} />
        </span>
        <span className="grow">
          {title}
          {badge !== undefined && <span className="badge accent" style={{ marginLeft: 8 }}>{badge}</span>}
          {subtitle !== undefined && <span className="sub">{subtitle}</span>}
        </span>
        <span className="chev" aria-hidden><Icon name="chevron" size={16} /></span>
      </button>
      {open && children !== undefined && <div className="option-body">{children}</div>}
    </div>
  );
}

export function TickList({ items }: { items: readonly string[] }) {
  return (
    <ul className="ticks">
      {items.map((item) => (
        <li key={item}>
          <Icon name="check" size={16} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
