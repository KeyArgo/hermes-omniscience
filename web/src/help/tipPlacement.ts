export const SHOW_DELAY_HOVER = 280;
export const SHOW_DELAY_FOCUS = 60;

type TipEl = {
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  closest(selector: string): TipEl | null;
  parentElement: TipEl | null;
};

function isBubble(el: TipEl): boolean {
  return el.matches('.tl-bubble') || el.closest('.tl-bubble') !== null;
}

export function tipTextFor(
  el: Element | null,
  extra: Record<string, string>,
): { target: HTMLElement; text: string } | null {
  if (!el) return null;
  let node: TipEl | null = el as unknown as TipEl;
  for (let i = 0; i < 6 && node; i++) {
    if (isBubble(node)) return null;
    const dataTip = node.getAttribute('data-tip');
    const movedTitle = node.getAttribute('data-tl-title');
    const title = node.getAttribute('title');
    let extraText: string | null = null;
    for (const selector of Object.keys(extra)) {
      if (node.matches(selector)) {
        extraText = extra[selector];
        break;
      }
    }
    const text = dataTip || title || movedTitle || extraText;
    if (text && text.trim()) {
      return { target: node as unknown as HTMLElement, text };
    }
    node = node.parentElement;
  }
  return null;
}

export function placeTip(
  target: { top: number; left: number; width: number; height: number },
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; side: 'top' | 'bottom' } {
  const gap = 8;
  const margin = 8;
  const preferBelow = target.top < viewport.height * 0.4;

  const belowTop = target.top + target.height + gap;
  const aboveTop = target.top - gap - bubble.height;

  const fitsBelow = belowTop + bubble.height <= viewport.height - margin;
  const fitsAbove = aboveTop >= margin;

  let side: 'top' | 'bottom';
  let top: number;
  if (preferBelow) {
    if (fitsBelow) {
      side = 'bottom';
      top = belowTop;
    } else if (fitsAbove) {
      side = 'top';
      top = aboveTop;
    } else {
      side = 'bottom';
      top = belowTop;
    }
  } else {
    if (fitsAbove) {
      side = 'top';
      top = aboveTop;
    } else if (fitsBelow) {
      side = 'bottom';
      top = belowTop;
    } else {
      side = 'top';
      top = aboveTop;
    }
  }

  let left = target.left + target.width / 2 - bubble.width / 2;

  top = Math.max(margin, Math.min(top, viewport.height - margin - bubble.height));
  left = Math.max(margin, Math.min(left, viewport.width - margin - bubble.width));

  return { top, left, side };
}
