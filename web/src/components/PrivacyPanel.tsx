import { useEffect } from "react";
import "./PrivacyPanel.css";

export function PrivacyPanel({
  open,
  onClose,
  dbPath,
}: {
  open: boolean;
  onClose: () => void;
  dbPath: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const location = dbPath || "the Omniscience data folder";

  return (
    <div
      className="pp-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="pp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pp-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pp-header">
          <h2 id="pp-title" className="pp-title">
            Your privacy
          </h2>
          <button
            type="button"
            className="pp-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="pp-body">
          <section className="pp-section">
            <h3 className="pp-h3">What Omniscience keeps</h3>
            <ul className="pp-list">
              <li>which steps happened and when</li>
              <li>timings and token counts</li>
              <li>model, provider and tool names</li>
              <li>names (not values) of tool settings</li>
              <li>error types and codes</li>
            </ul>
          </section>

          <section className="pp-section">
            <h3 className="pp-h3">What it never keeps</h3>
            <ul className="pp-list">
              <li>what you or the AI wrote</li>
              <li>prompts</li>
              <li>tool inputs and outputs</li>
              <li>file contents and commands</li>
              <li>error message text</li>
              <li>API keys</li>
            </ul>
          </section>

          <section className="pp-section">
            <h3 className="pp-h3">Where it lives</h3>
            <ul className="pp-list">
              <li>
                one file on this computer:{" "}
                <code className="pp-code">{location}</code>
              </li>
              <li>nothing is sent anywhere by Omniscience</li>
              <li>
                this page only answers this computer and needs a per-launch key
              </li>
            </ul>
          </section>

          <section className="pp-section">
            <h3 className="pp-h3">Your controls</h3>
            <ul className="pp-list">
              <li>
                type <code className="pp-code">/omni off</code> in a chat to
                stop recording it
              </li>
              <li>
                <code className="pp-code">/omni on</code> to resume
              </li>
              <li>
                <code className="pp-code">/omni forget</code> to delete its
                recording
              </li>
              <li>
                <code className="pp-code">/omni privacy</code> to see this in
                the chat
              </li>
              <li>
                set <code className="pp-code">OMNISCIENCE_NOTICES=0</code> to
                turn off live notices
              </li>
              <li>disable the Omniscience plugin to stop everything</li>
            </ul>
          </section>
        </div>

        <div className="pp-footer">
          <button type="button" className="pp-btn" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}
