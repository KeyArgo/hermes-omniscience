/**
 * Which interface mode a preference belongs to, for components that persist view settings but do
 * not own the mode state (panel heights and folds).
 *
 * App provides the mode; a component rendered outside the provider (tests, static markup) reads as
 * web, which is the shipped key it has always used.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { InterfaceMode } from './mode';

const PrefScopeContext = createContext<InterfaceMode>('web');

export function PrefScopeProvider({
  mode,
  children,
}: {
  mode: InterfaceMode;
  children: ReactNode;
}) {
  return <PrefScopeContext.Provider value={mode}>{children}</PrefScopeContext.Provider>;
}

export function usePrefScope(): InterfaceMode {
  return useContext(PrefScopeContext);
}
