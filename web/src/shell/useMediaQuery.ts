import { useEffect, useState } from 'react';

/**
 * A media query as React state, for the few behaviours CSS cannot express (which control the
 * Chats button is driving, whether focus should move into the drawer).
 *
 * Safe where matchMedia does not exist: reports false instead of throwing, and updates when the
 * window crosses the breakpoint rather than only at mount.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    try {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let mql: MediaQueryList;
    try {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
      mql = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = () => {
      try {
        setMatches(mql.matches);
      } catch {
        // A browser that hands back a broken MediaQueryList keeps the last answer.
      }
    };
    onChange();
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);

  return matches;
}
