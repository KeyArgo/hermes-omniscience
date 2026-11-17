import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import './MenuButton.css';

/** Gap kept between a menu and the window edge, and between the trigger and the menu. */
const EDGE = 8;
const GAP = 6;
const MAX_WIDTH = 440;

export interface MenuPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * Where a menu goes, in window coordinates. The menu is drawn in a layer above the page, so no
 * toolbar, sheet or scrolling panel can cut it off: it opens below the trigger, flips above when
 * there is more room there, never crosses a window edge, and scrolls inside itself when even the
 * larger side cannot hold it.
 */
export function placeMenu(
  trigger: { top: number; bottom: number; left: number; right: number },
  contentHeight: number,
  viewport: { width: number; height: number },
  align: 'start' | 'end',
): MenuPlacement {
  const width = Math.max(0, Math.min(MAX_WIDTH, viewport.width - EDGE * 2));
  const preferred = align === 'end' ? trigger.right - width : trigger.left;
  const left = Math.max(EDGE, Math.min(preferred, viewport.width - EDGE - width));
  const below = viewport.height - trigger.bottom - GAP - EDGE;
  const above = trigger.top - GAP - EDGE;
  const openUp = contentHeight > below && above > below;
  const room = Math.max(120, openUp ? above : below);
  const height = Math.min(contentHeight, room);
  const top = openUp
    ? Math.max(EDGE, trigger.top - GAP - height)
    : Math.min(trigger.bottom + GAP, Math.max(EDGE, viewport.height - EDGE - height));
  return { top, left, width, maxHeight: room };
}

export function moveFocusIndex(current: number, key: string, count: number): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count;
  return current;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-label" role="presentation">
      {children}
    </div>
  );
}

export function MenuSep() {
  return <div className="mb-sep" role="separator" />;
}

export function MenuItem({
  onSelect,
  disabled,
  children,
  hint,
}: {
  onSelect?: () => void;
  disabled?: boolean;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="mb-item"
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="mb-item-label">{children}</span>
      {hint ? <span className="mb-hint">{hint}</span> : null}
    </button>
  );
}

export function MenuCheck({
  checked,
  onChange,
  children,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className="mb-item mb-check"
      onClick={() => onChange(!checked)}
    >
      <span className="mb-check-box" aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
      <span className="mb-item-label">{children}</span>
      {hint ? <span className="mb-hint">{hint}</span> : null}
    </button>
  );
}

export function MenuButton({
  label,
  icon,
  badge,
  tip,
  align = 'start',
  children,
}: {
  label: string;
  icon?: ReactNode;
  badge?: number;
  tip?: string;
  align?: 'start' | 'end';
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Measure after render and before paint, then follow the trigger while the page scrolls or the
  // window resizes. Scroll is captured so a scrolling sheet or toolbar moves the menu with it.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current;
      const pop = popRef.current;
      if (!trigger || !pop) return;
      const next = placeMenu(
        trigger.getBoundingClientRect(),
        pop.scrollHeight,
        { width: window.innerWidth, height: window.innerHeight },
        align,
      );
      setPlacement((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.maxHeight === next.maxHeight
          ? prev
          : next,
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const focusItem = useCallback((index: number) => {
    const pop = popRef.current;
    if (!pop) return;
    const items = Array.from(
      pop.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
    ).filter((el) => !(el as HTMLButtonElement).disabled);
    if (items.length === 0) return;
    const target = items[Math.max(0, Math.min(index, items.length - 1))];
    target?.focus({ preventScroll: true });
  }, []);

  const placed = placement !== null;
  useEffect(() => {
    if (!open || !placed) return;
    // preventScroll: focusing before the first paint must not scroll a clipped ancestor.
    focusItem(0);
  }, [open, placed, focusItem]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!popRef.current?.contains(document.activeElement)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      const pop = popRef.current;
      if (!pop) return;
      const items = Array.from(
        pop.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
      ).filter((el) => !(el as HTMLButtonElement).disabled);
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const next = moveFocusIndex(current, e.key, items.length);
        items[next]?.focus();
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, close]);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const content = typeof children === 'function' ? children(close) : children;

  return (
    <div className="mb-root">
      <button
        ref={triggerRef}
        type="button"
        className="mb-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={tip}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        {icon ? <span className="mb-icon" aria-hidden="true">{icon}</span> : null}
        <span className="mb-label-text">{label}</span>
        <span className="mb-caret" aria-hidden="true">▾</span>
        {badge !== undefined && badge > 0 ? (
          <span className="mb-badge">{badge}</span>
        ) : null}
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              id={menuId}
              className={`mb-pop mb-pop-${align} mb-pop-floating`}
              role="menu"
              aria-label={label}
              style={popStyle(placement)}
              onClick={(e) => {
                const item = (e.target as HTMLElement).closest('[role="menuitem"]') as HTMLButtonElement | null;
                if (item && !item.disabled) close();
              }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** First frame: measured but not yet placed, so it is laid out off-screen and invisible. */
function popStyle(placement: MenuPlacement | null): CSSProperties {
  if (!placement) return { top: 0, left: 0, visibility: 'hidden' };
  return {
    top: placement.top,
    left: placement.left,
    width: placement.width,
    maxHeight: placement.maxHeight,
  };
}
