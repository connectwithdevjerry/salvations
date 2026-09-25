'use client';

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, ws } from '@/lib/client/api';
import { auth } from '@/lib/client/auth';
import {
  placeCard, SEEN_KEY, spotlightOf, stepsFor, type Placement, type Rect, type TourStep,
} from '@/lib/client/walkthrough';

/**
 * The walkthrough.
 *
 * A ring of light around one thing at a time, a card that says what it is,
 * and Next. It moves through the real product rather than pictures of it:
 * each step takes the page to where the thing is, opens the tab it is about,
 * and points. Somebody who finishes has already been everywhere they will
 * need to go.
 *
 * Shown once, on the first visit to a workspace, and again from the ? in the
 * top bar or from Settings. Whether it was seen is kept on the account, with
 * a local copy so a slow network does not show it twice.
 */

interface Walkthrough {
  /** Starts the tour from the beginning, wherever the person is. */
  start(): void;
}

const WalkthroughContext = createContext<Walkthrough | undefined>(undefined);

export function useWalkthrough(): Walkthrough {
  const walkthrough = useContext(WalkthroughContext);
  if (walkthrough === undefined) throw new Error('useWalkthrough needs a WalkthroughProvider above it.');
  return walkthrough;
}

export function WalkthroughProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [steps, setSteps] = useState<readonly TourStep[]>();

  const start = useCallback(async () => {
    // The tour walks one assistant's tabs; the main one if there is one.
    let agent: { id: string; name: string } | undefined;
    try {
      const result = await api.get<{ items: { id: string; name: string; main?: boolean }[] }>(`${ws(workspaceId)}/agents`);
      const first = result.items.find((a) => a.main === true) ?? result.items[0];
      if (first !== undefined) agent = { id: first.id, name: first.name };
    } catch {
      // Without the list the tour still runs, in its "make one" form.
    }
    // Owners and admins get the Admin step; nobody else can open that page.
    let admin = false;
    try {
      const mine = await api.get<{ items: { id: string; role: string }[] }>('/api/workspaces');
      const role = mine.items.find((w) => w.id === workspaceId)?.role;
      admin = role === 'owner' || role === 'admin';
    } catch {
      // Unknown role: the step is left out rather than pointed at nothing.
    }
    setSteps(stepsFor({ workspaceId, admin, ...(agent === undefined ? {} : { agent }) }));
  }, [workspaceId]);

  // First visit: once the page has settled, unless this account has seen it.
  useEffect(() => {
    if (readSeen()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    auth.session()
      .then((result) => {
        if (cancelled || result.user === null || result.user.walkthroughSeen) return;
        timer = setTimeout(() => { if (!cancelled) void start(); }, 700);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [start]);

  const finish = useCallback(() => {
    setSteps(undefined);
    writeSeen();
    void auth.markWalkthroughSeen().catch(() => undefined);
  }, []);

  const value = useMemo<Walkthrough>(() => ({ start: () => { void start(); } }), [start]);

  return (
    <WalkthroughContext.Provider value={value}>
      {children}
      {steps !== undefined && <Tour workspaceId={workspaceId} steps={steps} onDone={finish} />}
    </WalkthroughContext.Provider>
  );
}

/** How long to wait for a step's target to appear before showing the card without one. */
const FIND_TIMEOUT_MS = 4_000;
const MEASURE_MS = 150;

function Tour({
  workspaceId, steps, onDone,
}: {
  workspaceId: string;
  steps: readonly TourStep[];
  onDone: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState<Rect>();
  // True once the target was found, or the search was given up: the card is
  // not drawn while the page it belongs to is still loading.
  const [ready, setReady] = useState(false);
  const [placement, setPlacement] = useState<Placement>({ mode: 'centre' });
  const cardRef = useRef<HTMLDivElement>(null);

  const step = steps[Math.min(index, steps.length - 1)] as TourStep;
  const last = index >= steps.length - 1;

  // Go where the step lives.
  useEffect(() => {
    if (step.path === undefined) return;
    const wanted = `/w/${workspaceId}${step.path}`;
    if (pathname !== wanted) router.push(wanted);
  }, [step, pathname, router, workspaceId]);

  // Find the target, open it if it is a tab, and keep measuring it: the page
  // around it is still loading and shifting for a moment after navigation.
  useEffect(() => {
    setTarget(undefined);
    setReady(step.target === undefined);
    if (step.target === undefined) return;

    const wanted = step.target;
    const started = Date.now();
    let element: HTMLElement | null = null;
    let activated = false;

    const measure = () => {
      if (element === null || !element.isConnected) {
        element = document.querySelector<HTMLElement>(`[data-tour="${wanted}"]`);
        if (element === null) {
          if (Date.now() - started > FIND_TIMEOUT_MS) setReady(true);
          return;
        }
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (step.activate === true && !activated) {
          activated = true;
          element.click();
        }
      }
      const rect = element.getBoundingClientRect();
      setTarget((current) => (
        current !== undefined
        && current.top === rect.top && current.left === rect.left
        && current.width === rect.width && current.height === rect.height
          ? current
          : { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      ));
      setReady(true);
    };

    measure();
    const timer = setInterval(measure, MEASURE_MS);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  // The card's size is only known once it is drawn, so it is placed just after.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    setPlacement(placeCard(
      target,
      { width: card.offsetWidth, height: card.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [target, index, ready]);

  useEffect(() => { if (ready) cardRef.current?.focus(); }, [index, ready]);

  const next = useCallback(() => {
    if (last) onDone(); else setIndex((i) => i + 1);
  }, [last, onDone]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Escape leaves, the arrows move. The refs keep one listener current
  // without re-registering it every step.
  const keys = useRef({ next, back, onDone });
  keys.current = { next, back, onDone };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') keys.current.onDone();
      else if (event.key === 'ArrowRight') keys.current.next();
      else if (event.key === 'ArrowLeft') keys.current.back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const spot = target === undefined ? undefined : spotlightOf(target);
  const anchored = placement.mode === 'anchored' ? placement : undefined;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {spot !== undefined && ready
        ? <div className="tour-spot" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} aria-hidden />
        : <div className="tour-veil" aria-hidden />}

      {ready && (
        <div
          ref={cardRef}
          tabIndex={-1}
          className={`tour-card ${placement.mode}${anchored !== undefined ? ` ${anchored.side}` : ''}`}
          style={anchored === undefined ? undefined : { top: anchored.top, left: anchored.left }}
        >
          <p className="tour-count">{index + 1} of {steps.length}</p>
          <h3 id="tour-title">{step.title}</h3>
          <p>{step.body}</p>
          <div className="tour-actions">
            {!last && <button type="button" className="ghost" onClick={onDone}>Skip</button>}
            <span style={{ flex: 1 }} />
            {index > 0 && <button type="button" onClick={back}>Back</button>}
            <button type="button" className="primary" onClick={next}>{last ? 'Done' : 'Next'}</button>
          </div>
          <div className="tour-dots" aria-hidden>
            {steps.map((s, i) => <span key={s.id} className={i === index ? 'on' : i < index ? 'done' : ''} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function readSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Storage blocked: the account remembers instead.
  }
}
