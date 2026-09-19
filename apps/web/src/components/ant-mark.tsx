/**
 * The mark: one ant, seen from above, in three colours.
 *
 * An ant rather than a cell because the product is the workers, not the
 * building. Head, thorax and abdomen each get their own colour so it reads
 * as colourful at any size; legs and feelers share one warm-to-cool stroke.
 * Drawn once here and mirrored in app/icon.svg for the tab.
 */
export function AntMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      focusable="false"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        <linearGradient id="ant-limbs" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F59E0B" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      {/* Feelers and legs first, so the body sits on top of them. */}
      <g stroke="url(#ant-limbs)" strokeWidth="3.2">
        <path d="M27 10C23 4 17 3 13 7" />
        <path d="M37 10C41 4 47 3 51 7" />
        <path d="M26 26C19 21 13 21 8 15" />
        <path d="M38 26C45 21 51 21 56 15" />
        <path d="M25 32C17 33 11 36 6 42" />
        <path d="M39 32C47 33 53 36 58 42" />
        <path d="M27 37C20 43 16 49 15 57" />
        <path d="M37 37C44 43 48 49 49 57" />
      </g>
      {/* The waist and neck. */}
      <path d="M32 20v4M32 38v3" stroke="#EC4899" strokeWidth="3.2" />
      <ellipse cx="32" cy="14" rx="8" ry="7.2" fill="#F97316" />
      <ellipse cx="32" cy="31" rx="6.8" ry="8" fill="#EC4899" />
      <ellipse cx="32" cy="50" rx="10" ry="11.5" fill="#8B5CF6" />
      {/* Eyes. */}
      <circle cx="28.6" cy="13" r="1.6" fill="#FFF7ED" />
      <circle cx="35.4" cy="13" r="1.6" fill="#FFF7ED" />
      {/* A highlight on the abdomen, so it is a body and not a disc. */}
      <ellipse cx="28.5" cy="45" rx="2.6" ry="4" fill="#FFFFFF" opacity="0.28" />
    </svg>
  );
}
