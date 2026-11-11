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
}

function targetRect(sel: string): Rect | null {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function Tour({ forceStart, onClose }: { forceStart?: number; onClose?: () => void }) {
  const [mode, setMode] = useState<Mode>('hidden');
  const [step, setStep] = useState(0);
  const [ring, setRing] = useState<Rect | null>(null);
  const [pos, setPos] = useState<CardPos | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const stop = TOUR_STOPS[step];
  const last = step === TOUR_STOPS.length - 1;

  const measure = useCallback((idx: number) => {
    const s = TOUR_STOPS[idx];
    const rect = targetRect(s?.target ?? '');
    setRing(rect);
    const card = cardRef.current;
    const cw = card ? card.offsetWidth : 340;
    const ch = card ? card.offsetHeight : 160;
    setPos(
      placeCard(rect, { width: cw, height: ch }, { width: window.innerWidth, height: window.innerHeight }),
    );
  }, []);

  const begin = useCallback(() => {
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
    const decision = shouldOfferTour(readSeen(), window.location.search);
    if (decision === 'start') begin();
    else if (decision === 'offer') setMode('offer');
  }, [begin]);

  useEffect(() => {
    if (!forceStart) return;
    begin();
  }, [forceStart, begin]);

  useEffect(() => {
    if (mode !== 'run') return;
    const el = document.querySelector(stop.target);
    el?.scrollIntoView({ block: 'nearest' });
    measure(step);
    const onReflow = () => measure(step);
    window.addEventListener('resize', onReflow, { passive: true });
    window.addEventListener('scroll', onReflow, { passive: true, capture: true });
    const t = window.setTimeout(() => nextRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, { capture: true });
      window.clearTimeout(t);
    };
  }, [mode, step, measure]);

  useEffect(() => {
    if (mode !== 'run') return;
    const onKey = (e: KeyboardEvent) => {
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
