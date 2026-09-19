/**
 * Loading shown as the shape of what is coming, not as a spinner.
 *
 * A list that is about to appear is drawn as faint rows that shimmer; a page
 * as faint blocks. The eye reads the layout before the data, so the arrival
 * of the data is a fill, not a jump.
 */
export function SkeletonRows({ rows = 4, avatar = true }: { rows?: number; avatar?: boolean }) {
  return (
    <div className="skeleton" role="status" aria-label="Loading" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-row" style={{ animationDelay: `${i * 70}ms` }}>
          {avatar && <span className="skel skel-avatar" />}
          <span className="skel-lines">
            <span className="skel skel-line" style={{ width: `${46 + ((i * 17) % 30)}%` }} />
            <span className="skel skel-line thin" style={{ width: `${62 + ((i * 23) % 30)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function SkeletonPage({ blocks = 3 }: { blocks?: number }) {
  return (
    <div className="skeleton page" role="status" aria-label="Loading" aria-live="polite">
      <span className="skel skel-line title" style={{ width: '38%' }} />
      <span className="skel skel-line thin" style={{ width: '58%', marginBottom: 22 }} />
      {Array.from({ length: blocks }, (_, i) => (
        <span key={i} className="skel skel-block" style={{ animationDelay: `${i * 90}ms` }} />
      ))}
    </div>
  );
}
