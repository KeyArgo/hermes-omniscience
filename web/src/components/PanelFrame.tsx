import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Tip } from './Tip';
import './PanelFrame.css';

const STORE = 'omni.panel.';
const MAX_H = 1200;

export function clampHeight(h: number, min: number, max = MAX_H): number {
  return Math.max(min, Math.min(max, h));
}

export function heightForKey(h: number, key: string, shift: boolean, min: number, max = MAX_H): number | null {
  const step = shift ? 64 : 16;
  switch (key) {
    case 'ArrowDown':
      return clampHeight(h + step, min, max);
    case 'ArrowUp':
      return clampHeight(h - step, min, max);
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return null;
  }
}

function readString(key: string): string | null {
  try {
    return window.localStorage.getItem(STORE + key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string): void {
  try {
    window.localStorage.setItem(STORE + key, value);
  } catch {
    /* storage unavailable */
  }
}

function readNumber(key: string, fallback: number): number {
  const raw = Number(readString(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function writeNumber(key: string, value: number): void {
  writeString(key, String(Math.round(value)));
}

export function PanelFrame({
  id,
  title,
  tip,
  hint,
  defaultHeight = 240,
  minHeight = 120,
  collapsible = true,
  defaultFolded = false,
  summary,
  onHide,
  tourId,
  children,
}: {
  id: string;
  title: string;
  tip?: string;
  hint?: ReactNode;
  defaultHeight?: number;
  minHeight?: number;
  collapsible?: boolean;
  defaultFolded?: boolean;
  summary?: ReactNode;
  onHide?: () => void;
  tourId?: string;
  children: ReactNode;
}) {
  const [height, setHeight] = useState(() => clampHeight(readNumber(id + '.h', defaultHeight), minHeight));
  const [folded, setFolded] = useState(() => {
    const stored = readString(id + '.folded');
    return stored === null ? defaultFolded : stored === '1';
  });
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [focused, setFocused] = useState(false);
  const dragging = useRef<{ startY: number; startH: number } | null>(null);

  // Charts size from a percentage of an auto-height box (zero), so publish the measured body height.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setBodyHeight(Math.round(entry.contentRect.height));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!focused) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setFocused(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragging.current = { startY: event.clientY, startH: height };
      const move = (moveEvent: PointerEvent) => {
        if (!dragging.current) return;
        setHeight(clampHeight(dragging.current.startH + (moveEvent.clientY - dragging.current.startY), minHeight));
      };
      const up = () => {
        dragging.current = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setHeight((current) => {
          writeNumber(id + '.h', current);
          return current;
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [height, id, minHeight],
  );

  const onResizeKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const next = heightForKey(height, event.key, event.shiftKey, minHeight);
      if (next === null) return;
      event.preventDefault();
      setHeight(next);
      writeNumber(id + '.h', next);
    },
    [height, id, minHeight],
  );

  const toggleFold = useCallback(() => {
    setFolded((current) => {
      writeString(id + '.folded', current ? '0' : '1');
      return !current;
    });
  }, [id]);

  const dataAttrs = tourId ? { 'data-tour': tourId } : undefined;

  return (
    <section
      className={`pf${focused ? ' is-focused' : ''}${folded && !focused ? ' is-folded' : ''}`}
      data-panel={id}
      {...dataAttrs}
      style={focused ? undefined : ({ '--pf-h': `${height}px` } as React.CSSProperties)}
    >
      <header className="pf-head">
        <h3 className="pf-title">
          {title}
          {tip ? (
            <Tip text={tip} side="bottom">
              <span className="us-hint">?</span>
            </Tip>
          ) : null}
          {hint ? <span className="pf-hint">{hint}</span> : null}
        </h3>
        {summary ? <div className="pf-summary">{summary}</div> : null}
        <div className="pf-actions">
          {collapsible ? (
            <button
              type="button"
              className="pf-btn"
              onClick={toggleFold}
              aria-expanded={!folded}
              title={folded ? 'Unfold the panel' : 'Fold to its title bar'}
              aria-label={folded ? 'Unfold panel' : 'Fold panel'}
            >
              {folded ? '+' : '–'}
            </button>
          ) : null}
          <button
            type="button"
            className="pf-btn"
            onClick={() => setHeight((h) => (h > defaultHeight + 40 ? defaultHeight : Math.max(520, h * 2)))}
            title={height > defaultHeight + 40 ? 'Back to the default height' : 'Give this panel twice the room'}
            aria-label="Toggle panel height"
          >
            ↕
          </button>
          {onHide && !focused ? (
            <button
              type="button"
              className="pf-btn"
              onClick={onHide}
              title="Hide this panel — bring it back from Panels"
              aria-label="Hide panel"
            >
              ×
            </button>
          ) : null}
          <button
            type="button"
            className="pf-btn"
            onClick={() => setFocused((f) => !f)}
            title={focused ? 'Leave focus (Esc)' : 'Focus this panel (Esc to leave)'}
            aria-label="Focus panel"
            aria-pressed={focused}
          >
            {focused ? '×' : '⤢'}
          </button>
        </div>
      </header>
      <div
        className="pf-body"
        ref={bodyRef}
        hidden={folded && !focused}
        style={{ '--pf-body-h': `${bodyHeight}px` } as React.CSSProperties}
      >
        {children}
      </div>
      {focused || folded ? null : (
        <div
          className="pf-resize"
          onPointerDown={onPointerDown}
          onKeyDown={onResizeKey}
          tabIndex={0}
          role="separator"
          aria-orientation="horizontal"
          aria-valuemin={minHeight}
          aria-valuemax={MAX_H}
          aria-valuenow={height}
          aria-label="Resize panel — drag or use the arrow keys"
          title="Drag to resize"
        />
      )}
    </section>
  );
}
