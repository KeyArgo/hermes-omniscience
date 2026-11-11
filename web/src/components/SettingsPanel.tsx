import { useEffect, useState } from 'react';
import { getPrefs, setPrefs } from '../api';
import type { ChatPrefs } from '../types';
import './SettingsPanel.css';

export type ViewMode =
  | 'list' | 'graph' | 'time' | 'tokens' | 'usage' | 'privacy' | 'concerns'
  | 'flame' | 'tools' | 'context' | 'helpers' | 'coverage' | 'latency';

export type ThemeName = 'console' | 'paper';

export interface ViewerSettings {
  defaultView: ViewMode;
  compact: boolean;
  followNewest: boolean;
  showTitles: boolean;
  showContext: boolean;
  theme: ThemeName;
}

interface Props {
  open: boolean;
  settings: ViewerSettings;
  onChange: (next: ViewerSettings) => void;
  onOpenPrivacy: () => void;
  /** Put every panel, filter, zoom and remembered view back to how it started. */
  onResetView: () => void;
  onClose: () => void;
}

const VIEW_LABELS: Record<ViewMode, string> = {
  list: 'List (one row per message)',
  graph: 'Graph (boxes and arrows)',
  time: 'Time (bars as long as each step)',
  tokens: 'Tokens (cached vs new, speed per model)',
  usage: 'Usage (what this machine spent)',
  privacy: 'Privacy (browser, desktop, sweeps, network)',
  concerns: 'Concerns (what needs attention, summarised)',
  flame: 'Flame (time across, depth down)',
  tools: 'Tools (which tools ran, failures)',
  context: 'Context (how the chat grew)',
  helpers: 'Helpers (helper agents side by side)',
  latency: 'Latency (how long models really take)',
  coverage: 'Coverage (how complete the recording is)',
};

/** Every Omniscience setting in one place. Viewer settings apply at once; recording settings are chat commands. */
export function SettingsPanel({ open, settings, onChange, onOpenPrivacy, onResetView, onClose }: Props) {
  const [alertsOn, setAlertsOn] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('omni.privacyAlerts') !== 'off';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // The in-chat summary lives in the plugin's own settings file, not in this browser.
  const [prefs, setLocalPrefs] = useState<ChatPrefs | null>(null);
  const [prefsNote, setPrefsNote] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    getPrefs()
      .then((next) => {
        if (live) setLocalPrefs(next);
      })
      .catch(() => {
        if (live) setPrefsNote('Could not read the chat settings from the plugin.');
      });
    return () => {
      live = false;
    };
  }, [open]);

  if (!open) return null;
  const set = (patch: Partial<ViewerSettings>) => onChange({ ...settings, ...patch });

  const savePrefs = (patch: { digest?: { enabled?: boolean; detail?: 'brief' | 'standard' | 'full' } }) => {
    if (prefs) {
      setLocalPrefs({
        digest: {
          enabled: patch.digest?.enabled ?? prefs.digest.enabled,
          detail: patch.digest?.detail ?? prefs.digest.detail,
        },
      });
    }
    setPrefsNote('saving…');
    setPrefs(patch)
      .then((next) => {
        setLocalPrefs(next);
        setPrefsNote('saved — it applies from the next turn, no restart');
      })
      .catch(() => setPrefsNote('Could not save that setting; nothing changed.'));
  };

  return (
    <div className="sp-backdrop" onClick={onClose}>
      <div className="sp-dialog" role="dialog" aria-modal="true" aria-label="Omniscience settings" onClick={(e) => e.stopPropagation()}>
        <div className="sp-head">
          <h2>Settings</h2>
          <button type="button" className="sp-close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <section>
          <h3>What you see</h3>
          <label className="sp-row">
            <span>Context chart under each chat</span>
            <input
              type="checkbox"
              checked={settings.showContext}
              onChange={(e) => set({ showContext: e.target.checked })}
            />
          </label>
          <p className="sp-note">
            A small chart of how many tokens each message re-sent, with a line where the context
            dropped. It appears under the summary of whichever chat you have open; ⤢ enlarges it.
          </p>
          <label className="sp-row">
            <span>Look</span>
            <select value={settings.theme} onChange={(e) => set({ theme: e.target.value as ThemeName })}>
              <option value="console">Console — deep space, neon cyan and violet</option>
              <option value="paper">Paper — warm graphite and brass</option>
            </select>
          </label>
          <label className="sp-row">
            <span>Open chats in</span>
            <select value={settings.defaultView} onChange={(e) => set({ defaultView: e.target.value as ViewMode })}>
              {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {VIEW_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
          <label className="sp-row">
            <input type="checkbox" checked={settings.compact} onChange={(e) => set({ compact: e.target.checked })} />
            <span>Compact text (a panel grows back while your mouse is over it)</span>
          </label>
          <label className="sp-row">
            <input
              type="checkbox"
              checked={settings.followNewest}
              onChange={(e) => set({ followNewest: e.target.checked })}
            />
            <span>Follow newest: jump to whichever chat is working right now</span>
          </label>
          <label className="sp-row">
            <input
              type="checkbox"
              checked={alertsOn}
              onChange={(e) => {
                setAlertsOn(e.target.checked);
                try {
                  window.localStorage.setItem('omni.privacyAlerts', e.target.checked ? 'on' : 'off');
                } catch {
                  /* storage unavailable */
                }
                window.dispatchEvent(new Event('omni:privacy'));
              }}
            />
            <span>
              Privacy alerts: pulse the window and put a strip in the title bar whenever a chat drives a browser or this
              desktop. On by default. Network and MCP calls are not alerted — they get a quiet count beside it. A sweep of
              many files would qualify, but the recorder is only told a tool's name and how long it took, so it cannot
              count them yet.
            </span>
          </label>
          <label className="sp-row">
            <input type="checkbox" checked={settings.showTitles} onChange={(e) => set({ showTitles: e.target.checked })} />
            <span>
              Show chat titles. Titles come from Hermes and can include the start of what you typed; turn this off
              before sharing your screen.
            </span>
          </label>
        </section>

        <section>
          <h3>In the chat</h3>
          <p className="sp-muted">
            At the end of every turn Omniscience posts what ran, how many tokens each message is sending, whether the
            chat is now expensive to keep alive, and anything that failed. You can also stop it with
            <code>/omni digest off</code> in any chat.
          </p>
          <label className="sp-row">
            <input
              type="checkbox"
              checked={prefs ? prefs.digest.enabled : true}
              onChange={(e) => savePrefs({ digest: { enabled: e.target.checked } })}
            />
            <span>Post the turn summary in my chat</span>
          </label>
          <label className="sp-row">
            <span>How much it says</span>
            <select
              value={prefs ? prefs.digest.detail : 'standard'}
              onChange={(e) => savePrefs({ digest: { detail: e.target.value as 'brief' | 'standard' | 'full' } })}
            >
              <option value="brief">Brief — what ran, and anything that failed</option>
              <option value="standard">Standard — adds tokens, cache reuse and the compaction warning</option>
              <option value="full">Full — adds model switches, compactions and the slowest step</option>
            </select>
          </label>
          {prefsNote ? <p className="sp-note">{prefsNote}</p> : null}
        </section>

        <section>
          <h3>Recording and privacy</h3>
          <p className="sp-muted">
            Omniscience keeps which steps happened, when, and how big they were. It never keeps what you or the AI
            wrote. These are typed in any Hermes chat:
          </p>
          <ul className="sp-commands">
            <li>
              <code>/omni off</code> stop recording this chat · <code>/omni on</code> resume
            </li>
            <li>
              <code>/omni forget</code> delete this chat's recording
            </li>
            <li>
              <code>/omni privacy</code> show exactly what is kept and where
            </li>
            <li>
              Live notices in the chat: set <code>OMNISCIENCE_NOTICES=0</code> to turn them off
            </li>
          </ul>
          <button type="button" className="sp-link" onClick={onOpenPrivacy}>
            What exactly is kept? →
          </button>
        </section>

        <section>
          <h3>Lost your place?</h3>
          <p className="sp-muted">
            Folded panels, an odd zoom, filters left on, a view you no longer want. This puts everything back the
            way it was the first time you opened Omniscience. It only changes what you see; nothing is deleted from
            the recording.
          </p>
          <button type="button" className="sp-reset" onClick={onResetView}>
            Reset view
          </button>
        </section>
      </div>
    </div>
  );
}
