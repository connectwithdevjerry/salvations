'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `fn` now and then every `ms` — while the tab is visible.
 *
 * A background tab polling every ten seconds is a request every ten seconds
 * for nothing: nobody is looking. It stops when the tab is hidden and runs
 * once, immediately, when the tab comes back, so what is shown is fresh the
 * moment somebody looks rather than up to `ms` stale.
 */
export function usePoll(fn: () => void, ms: number, active = true): void {
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (timer !== undefined) return;
      latest.current();
      timer = setInterval(() => latest.current(), ms);
    };
    const stop = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());

    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, active]);
}
