export interface TourStop {
  id: string;
  target: string;
  title: string;
  body: string;
}

export const TOUR_STOPS: TourStop[] = [
  {
    id: 'chats',
    target: '[data-tour="chats"]',
    title: 'Pick a chat',
    body: 'Every recorded Hermes chat is listed here. Choose one to see what happened.',
  },
  {
    id: 'status',
    target: '[data-tour="status"]',
    title: 'What happened, in one line',
    body: 'The verdict and summary of the run. Open Briefing for the full plain-English summary, the failures and the timeline.',
  },
  {
    id: 'context',
    target: '[data-tour="context"]',
    title: 'Tokens per call',
    body: 'How much context each model call re-sent; spot where it piled up and where it was compacted. Drag the bottom edge to resize, ⤢ to enlarge, – to fold it.',
  },
  {
    id: 'map',
    target: '[data-tour="map"]',
    title: 'The map',
    body: 'Each box is a model call or a tool run. Click one to inspect its timing, tokens and warnings.',
  },
  {
    id: 'panels',
    target: '[data-tour="panels"]',
    title: 'Make it yours',
    body: 'Show or hide any panel, switch between Simple, Standard and Everything, and reset the layout any time.',
  },
];

export const TOUR_KEY = 'omni.tourSeen';

export function shouldOfferTour(seen: string | null, search: string): 'offer' | 'start' | 'none' {
  if (/(?:^|[?&])tour=1(?:&|$)/.test(search)) return 'start';
  if (seen === null) return 'offer';
  return 'none';
}

export function nextIndex(i: number, dir: 1 | -1, total: number): number | null {
  const next = i + dir;
  if (next < 0) return 0;
  if (next >= total) return null;
  return next;
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  placement: 'below' | 'above' | 'center';
}

const GAP = 12;

export function placeCard(
  target: Rect | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const clampLeft = (left: number) => Math.min(Math.max(left, GAP), Math.max(GAP, viewport.width - card.width - GAP));
  const clampTop = (top: number) => Math.min(Math.max(top, GAP), Math.max(GAP, viewport.height - card.height - GAP));

  if (target) {
    const belowTop = target.top + target.height + GAP;
    if (belowTop + card.height <= viewport.height - GAP) {
      return { top: clampTop(belowTop), left: clampLeft(target.left), placement: 'below' };
    }
    const aboveTop = target.top - GAP - card.height;
    if (aboveTop >= GAP) {
      return { top: clampTop(aboveTop), left: clampLeft(target.left), placement: 'above' };
    }
  }

  const centerLeft = (viewport.width - card.width) / 2;
  const centerTop = (viewport.height - card.height) / 2;
  return { top: clampTop(centerTop), left: clampLeft(centerLeft), placement: 'center' };
}
