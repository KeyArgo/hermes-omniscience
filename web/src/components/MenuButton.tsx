import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './MenuButton.css';

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

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
    target?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    focusItem(0);
  }, [open, focusItem]);

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
      {open ? (
        <div
          ref={popRef}
          id={menuId}
          className={`mb-pop mb-pop-${align}`}
          role="menu"
          aria-label={label}
          onClick={(e) => {
            const item = (e.target as HTMLElement).closest('[role="menuitem"]') as HTMLButtonElement | null;
            if (item && !item.disabled) close();
          }}
        >
          {content}
        </div>
      ) : null}
    </div>
  );
}
