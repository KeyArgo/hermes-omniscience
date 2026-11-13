import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { placeTip, SHOW_DELAY_FOCUS, SHOW_DELAY_HOVER, tipTextFor } from './tipPlacement';
import './TipLayer.css';

type Shown = {
  target: HTMLElement;
  text: string;
  prevDescribedBy: string | null;
};

const NONE: Record<string, string> = {};

export function TipLayer({ extra = NONE }: { extra?: Record<string, string> }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const keyboardRef = useRef(false);
  const shownRef = useRef<Shown | null>(null);

  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const hide = () => {
      clearTimer();
      const current = shownRef.current;
      if (current) {
        const ids = (current.target.getAttribute('aria-describedby') ?? '')
          .split(/\s+/).filter((id) => id && id !== 'tl-bubble');
        if (ids.length) current.target.setAttribute('aria-describedby', ids.join(' '));
        else current.target.removeAttribute('aria-describedby');
        const movedTitle = current.target.getAttribute('data-tl-title');
        if (movedTitle !== null && !current.target.hasAttribute('title')) {
          current.target.setAttribute('title', movedTitle);
        }
        current.target.removeAttribute('data-tl-title');
      }
      shownRef.current = null;
      setShown(null);
      setPos(null);
    };

    const show = (target: HTMLElement, text: string) => {
      if (shownRef.current) hide();
      const title = target.getAttribute('title');
      if (title !== null) {
        target.setAttribute('data-tl-title', title);
        target.removeAttribute('title');
      }
      const prevDescribedBy = target.getAttribute('aria-describedby');
      target.setAttribute('aria-describedby', [prevDescribedBy, 'tl-bubble'].filter(Boolean).join(' '));
      const next = { target, text, prevDescribedBy };
      shownRef.current = next;
      setShown(next);
    };

    const schedule = (el: Element | null, delay: number) => {
      clearTimer();
      if (el?.closest('.tour-card, .tour-offer')) return;
      const resolved = tipTextFor(el, extra);
      if (!resolved) return;
      const { target, text } = resolved;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        show(target, text);
      }, delay);
    };

    const onPointerOver = (e: PointerEvent) => {
      const resolved = tipTextFor(e.target as Element | null, extra);
      if (!resolved) return;
      const current = shownRef.current;
      if (current && current.target === resolved.target) return;
      schedule(e.target as Element | null, SHOW_DELAY_HOVER);
    };

    const onPointerOut = (e: PointerEvent) => {
      const resolved = tipTextFor(e.target as Element | null, extra);
      if (!resolved) return;
      const related = e.relatedTarget as Element | null;
      if (related && resolved.target.contains(related)) return;
      const current = shownRef.current;
      if (current && current.target === resolved.target) {
        hide();
      } else {
        clearTimer();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      keyboardRef.current = true;
      if (e.key === 'Escape') hide();
    };

    const onPointerDown = () => {
      keyboardRef.current = false;
      hide();
    };

    const onFocusIn = (e: FocusEvent) => {
      if (!keyboardRef.current) return;
      schedule(e.target as Element | null, SHOW_DELAY_FOCUS);
    };

    const onFocusOut = (e: FocusEvent) => {
      const resolved = tipTextFor(e.target as Element | null, extra);
      if (!resolved) return;
      const related = e.relatedTarget as Element | null;
      if (related && resolved.target.contains(related)) return;
      const current = shownRef.current;
      if (current && current.target === resolved.target) {
        hide();
      } else {
        clearTimer();
      }
    };

    const onScroll = () => hide();
    const onResize = () => hide();

    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);

    return () => {
      hide();
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [extra]);

  useLayoutEffect(() => {
    if (!shown || !bubbleRef.current) return;
    const rect = shown.target.getBoundingClientRect();
    const bubbleRect = bubbleRef.current.getBoundingClientRect();
    const next = placeTip(
      { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      { width: bubbleRect.width, height: bubbleRect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos(next);
  }, [shown]);

  if (!shown) return null;

  const side = pos?.side ?? 'bottom';
  const style = pos
    ? { top: `${pos.top}px`, left: `${pos.left}px` }
    : { top: '0px', left: '0px', visibility: 'hidden' as const };

  return (
    <div
      id="tl-bubble"
      role="tooltip"
      ref={bubbleRef}
      className={`tl-bubble tl-${side}${pos ? ' tl-visible' : ''}`}
      style={style}
    >
      {shown.text}
    </div>
  );
}
