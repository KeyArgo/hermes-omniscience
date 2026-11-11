import type { ReactNode } from 'react';

/**
 * A tooltip that explains what is on screen.
 *
 * Native `title` attributes take a second to appear, cannot be styled, and do
 * not work on a laptop trackpad as well as a real bubble. This shows on hover
 * and on keyboard focus, and keeps the text on one readable line block.
 */
export function Tip({
  text,
  children,
  side = 'top',
  wide = false,
}: {
  text: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  wide?: boolean;
}) {
  return (
    <span className={`tip tip-${side}${wide ? ' tip-wide' : ''}`} data-tip={text}>
      {children}
    </span>
  );
}
