export type BrowserLaunch = null | 'opening' | 'opened' | 'failed' | 'no-answer';

const TEXT: Record<Exclude<BrowserLaunch, null>, string> = {
  opening: 'Opening the full workspace in your web browser…',
  opened: 'Opened in your web browser. This pane stays in Hermes mode.',
  failed: 'Hermes could not open your web browser.',
  'no-answer':
    'Hermes did not answer, so nothing was opened. Reload Omniscience in Hermes (or update the plugin) and try again.',
};

/**
 * What happened when the reader asked for the web version from inside Hermes. Said in words, in a
 * live region, and never by flipping the mode switch: the frame did not become the web view.
 */
export function BrowserLaunchNote({
  state,
  onRetry,
  onUseHere,
  onDismiss,
}: {
  state: BrowserLaunch;
  onRetry: () => void;
  onUseHere: () => void;
  onDismiss: () => void;
}) {
  const problem = state === 'failed' || state === 'no-answer';
  return (
    <div className={`browser-launch${state ? ` is-${state}` : ''}`} role="status" aria-live="polite">
      {state ? (
        <>
          <span className="browser-launch-text">{TEXT[state]}</span>
          {problem ? (
            <>
              <button type="button" className="chip" onClick={onRetry}>
                Try again
              </button>
              <button
                type="button"
                className="chip"
                onClick={onUseHere}
                title="Show the Web layout inside this Hermes page instead. Hermes stays one press away."
              >
                Use Web layout here
              </button>
            </>
          ) : null}
          {state !== 'opening' ? (
            <button type="button" className="icon-button" onClick={onDismiss} aria-label="Dismiss">
              ×
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
