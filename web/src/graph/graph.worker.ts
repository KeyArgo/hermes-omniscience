import { layout, reduce } from './reduce';
import { foldBusyTurns } from './collapse';
import { filterGraph } from './filter';
import { windowGraph } from './window';
import type { OmniEvent } from '../types';

self.onmessage = (message: MessageEvent<{ events: OmniEvent[]; expanded: string[]; hideTools: boolean; hideLlms: boolean; errorsOnly: boolean }>) => {
  const { events, expanded, hideTools, hideLlms, errorsOnly } = message.data;
  const fullGraph = reduce(events);
  // Bound layout, not just the number of DOM elements drawn afterward.
  // Fold before windowing: a busy turn's own node is its oldest, so windowing first can drop it
  // and leave hundreds of its children unfolded.
  const expandedSet = new Set(expanded);
  const windowed = windowGraph(foldBusyTurns(fullGraph, expandedSet));
  const baseGraph = layout(windowed.graph);
  // Filter before folding, so hidden kinds are not tucked inside group boxes.
  const filtering = hideTools || hideLlms || errorsOnly;
  const graph = filtering
    ? (() => {
        const filtered = filterGraph(fullGraph, hideTools, hideLlms, errorsOnly);
        // "Errors only" is short by nature; folding it would hide the very failures asked for.
        return layout(windowGraph(errorsOnly ? filtered : foldBusyTurns(filtered, expandedSet)).graph);
      })()
    : baseGraph;
  self.postMessage({ fullGraph, baseGraph, graph, truncated: windowed.truncated });
};
