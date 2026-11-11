import type { RiskHit } from '../privacy/risk';
import './PrivacyAlert.css';

/**
 * The one thing on this screen that must be impossible to miss: something is driving a browser or
 * your desktop, or sweeping your disk. It sits in the title bar, it pulses the whole window blue,
 * and it offers both ways out — stop the chat, or skip this action.
 */
export function PrivacyAlert({
  hit,
  toolName,
  onFlag,
  onIgnore,
  onOpenSettings,
  onDismiss,
  ageSeconds,
  ranMs,
  chatLabel,
}: {
  hit: RiskHit;
  toolName: string;
  /** Recorded age of the run, in seconds, at the moment the chat last moved. */
  ageSeconds: number;
  /** How long the tool itself took, in milliseconds, when it was recorded. */
  ranMs: number | null;
  /** Which chat ran it, so "browser use" is never an anonymous alarm. */
  chatLabel?: string | null;
  onFlag: () => void;
  onIgnore: () => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {

  return (
    <div className="privacy-alert" role="alert" aria-live="assertive">
      <span className="pa-dot" aria-hidden="true" />
      <span className="pa-label">{hit.label}</span>
      <span className="pa-tool" title="The recorded tool name">
        {toolName}
      </span>
      {chatLabel ? (
        <span className="pa-chat" title="The chat that ran this">
          {chatLabel}
        </span>
      ) : null}
      <span className="pa-time" title="When it ran, and how long it took">
        {ageSeconds < 60 ? `${Math.max(0, Math.round(ageSeconds))}s ago` : `${Math.round(ageSeconds / 60)} min ago`}
        {ranMs !== null ? ` · ran ${ranMs >= 1000 ? `${Math.round(ranMs / 100) / 10}s` : `${Math.round(ranMs)}ms`}` : ''}
      </span>
      <span className="pa-actions">
        <button
          type="button"
          className="pa-btn pa-flag"
          onClick={onFlag}
          title="Flag this chat: write the action, the session, the steps around it and both clock times to a file you can investigate later. Works for browser use, desktop use, wide file sweeps, network and MCP calls."
        >
          Flag this chat
        </button>
        <button
          type="button"
          className="pa-btn"
          onClick={onIgnore}
          title="Ignore this action: the strip goes away and stays away for this run, including after a reload."
        >
          Ignore
        </button>
        <button type="button" className="pa-btn pa-quiet" onClick={onOpenSettings} title="Where the alert can be switched off">
          Alerts
        </button>
        <button type="button" className="pa-x" onClick={onDismiss} aria-label="Hide this alert for now (it returns only for a new run)">
          ✕
        </button>
      </span>
    </div>
  );
}
