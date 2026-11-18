import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TOUR_KEY,
  TOUR_STOPS,
  nextIndex,
  placeCard,
  shouldOfferTour,
  type Rect,
} from '../help/tour';
import './Tour.css';
import { tokenHeaders } from '../token';
import { API_BASE } from '../api';
import { currentInterfaceScale } from '../shell/interfaceSize';

type Mode = 'hidden' | 'offer' | 'run';

interface CardPos {
  top: number;
  left: number;
  placement: 'below' | 'above' | 'center';
}

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(TOUR_KEY);
  } catch {
    return null;
  }
}

function writeSeen() {
  try {
    window.localStorage.setItem(TOUR_KEY, '1');
  } catch {
    /* storage may throw; tour still ends */
  }
  void fetch(`${API_BASE}/tour-seen`, { method: 'POST', headers: tokenHeaders() }).catch(() => {});
}

/**
 * Where a target is, in the app root's own pixels.
 *
 * The ring and the card are `position: fixed` inside the root, so they are laid out in the root's
 * pixels — and with Interface size under 100% (styles.css puts a `zoom` on the root) the root's
 * pixels are smaller than the window's. `getBoundingClientRect` answers in window pixels, so at 80%
 * a ring drawn from raw numbers sits a fifth of the screen away from the control it points at.
 */
function targetRect(sel: string): Rect | null {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const scale = currentInterfaceScale();
  return {
    top: r.top / scale,
    left: r.left / scale,
    width: r.width / scale,
    height: r.height / scale,
  };
}

export function Tour({
  forceStart,
  onClose,
  onActiveChange,
}: {
  forceStart?: number;
  onClose?: () => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>('hidden');
  const [step, setStep] = useState(0);
  const [ring, setRing] = useState<Rect | null>(null);
  const [pos, setPos] = useState<CardPos | null>(null);
  // The viewport is state, not just an event listener: React's responsive layout commits after the
  // browser's resize event, so measuring in a post-commit effect is what catches the final position.
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const interactedRef = useRef(false);
  const stop = TOUR_STOPS[step];
  const last = step === TOUR_STOPS.length - 1;

  const measure = useCallback((idx: number) => {
    const s = TOUR_STOPS[idx];
    const rect = targetRect(s?.target ?? '');
    setRing(rect);
    const card = cardRef.current;
    const cw = card ? card.offsetWidth : 340;
    const ch = card ? card.offsetHeight : 160;
    // The card is laid out in the root's pixels too, so the box it is placed in is the window
    // divided by the same scale the target was measured in.
    const scale = currentInterfaceScale();
    setPos(
      placeCard(rect, { width: cw, height: ch }, {
        width: window.innerWidth / scale,
        height: window.innerHeight / scale,
      }),
    );
  }, []);

  const begin = useCallback(() => {
    interactedRef.current = true;
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    setStep(0);
    setMode('run');
  }, []);

  const finish = useCallback(() => {
    writeSeen();
    setMode('hidden');
    prevFocusRef.current?.focus();
    onClose?.();
  }, [onClose]);

  const goto = useCallback(
    (idx: number | null) => {
      if (idx === null) {
        finish();
        return;
      }
      setStep(idx);
    },
    [finish],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    const localSeen = readSeen();
    const decision = shouldOfferTour(localSeen, window.location.search);
    if (decision === 'start') begin();
    else if (decision === 'offer') {
      void fetch(`${API_BASE}/tour-seen`, { headers: tokenHeaders() })
        .then((response) => {
          if (!response.ok) throw new Error('Tour state unavailable');
          return response.json() as Promise<{ seen: boolean }>;
        })
        .then((state) => {
          if (!cancelled && !interactedRef.current && !state.seen) setMode((current) => current === 'hidden' ? 'offer' : current);
        })
        .catch(() => {
          if (!cancelled && !interactedRef.current) setMode((current) => current === 'hidden' ? 'offer' : current);
        });
    }
    return () => { cancelled = true; };
  }, [begin]);

  useEffect(() => {
    if (!forceStart) return;
    begin();
  }, [forceStart, begin]);

  useEffect(() => {
    onActiveChange?.(mode !== 'hidden');
  }, [mode, onActiveChange]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Re-measure after every committed viewport change, so a breakpoint-crossing tour rings the
  // target where React finally placed it rather than where the resize event first saw it.
  useEffect(() => {
    if (mode !== 'run') return;
    measure(step);
    // React's responsive commit and CSS media layout can both settle one frame later.
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => measure(step));
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second) window.cancelAnimationFrame(second);
    };
  }, [mode, step, measure, viewport.width, viewport.height]);

  // React's responsive re-render can resize or move the target after the viewport effect has run.
  // Observe the target and the header that reflows it (the 1000/1440 breakpoints move controls
  // without necessarily resizing the target) so a moved ring is measured again.
  useEffect(() => {
    if (mode !== 'run' || typeof ResizeObserver === 'undefined') return;
    const el = document.querySelector(stop.target);
    const header = document.querySelector('.topbar');
    if (!el && !header) return;
    const observer = new ResizeObserver(() => measure(step));
    if (el) observer.observe(el);
    if (header) observer.observe(header);
    return () => observer.disconnect();
  }, [mode, step, stop.target, measure, viewport.width, viewport.height]);

  useEffect(() => {
    if (mode !== 'run') return;
    const el = document.querySelector(stop.target);
    el?.scrollIntoView({ block: 'nearest' });
    const onReflow = () => measure(step);
    window.addEventListener('scroll', onReflow, { passive: true, capture: true });
    const t = window.setTimeout(() => nextRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('scroll', onReflow, { capture: true });
      window.clearTimeout(t);
    };
  }, [mode, step, measure]);

  useEffect(() => {
    if (mode !== 'run') return;
    const onKey = (e: KeyboardEvent) => {
      // A Settings/Privacy/Help/Insight modal owns the keyboard; the Tour must not close or step
      // behind it. Escape is handled by the topmost dialog.
      if (
        e.defaultPrevented ||
        document.querySelector('[role="dialog"][aria-modal="true"]') !== null
      ) {
        return;
      }
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape') finish();
      else if (typing) return;
      else if (e.key === 'ArrowRight') goto(nextIndex(step, 1, TOUR_STOPS.length));
      else if (e.key === 'ArrowLeft') goto(nextIndex(step, -1, TOUR_STOPS.length));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, step, finish, goto]);

  if (typeof window === 'undefined') return null;

  if (mode === 'hidden') return null;

  if (mode === 'offer') {
    return (
      <div className="tour-offer" role="dialog" aria-label="Quick tour offer">
        <h2 className="tour-offer-title">New here?</h2>
        <p className="tour-offer-body">Want a 30-second tour of the map and how to turn on more panels?</p>
        <div className="tour-offer-actions">
          <button type="button" className="tour-btn tour-btn-primary" onClick={begin}>
            Start Tour
          </button>
          <button
            type="button"
            className="tour-btn"
            onClick={() => {
              writeSeen();
              setMode('hidden');
            }}
          >
            Not Now
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {ring && <div className="tour-ring" style={{ top: ring.top - 8, left: ring.left - 8, width: ring.width + 16, height: ring.height + 16 }} />}
      <div
        className={`tour-card tour-card-${pos?.placement ?? 'center'}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-card-title"
        ref={cardRef}
        style={{ top: pos?.top, left: pos?.left }}
      >
        <p className="tour-step">Step {step + 1} of {TOUR_STOPS.length}</p>
        <h2 className="tour-title" id="tour-card-title">{stop.title}</h2>
        <p className="tour-body">{stop.body}</p>
        <div className="tour-actions">
          <button type="button" className="tour-btn tour-btn-link" onClick={finish}>
            Skip Tour
          </button>
          <span className="tour-spacer" />
          <button
            type="button"
            className="tour-btn"
            disabled={step === 0}
            onClick={() => goto(nextIndex(step, -1, TOUR_STOPS.length))}
          >
            Back
          </button>
          <button
            type="button"
            className="tour-btn tour-btn-primary"
            ref={nextRef}
            onClick={() => goto(nextIndex(step, 1, TOUR_STOPS.length))}
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </>
  );
}
