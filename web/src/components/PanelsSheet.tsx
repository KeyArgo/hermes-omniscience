import { useEffect, useRef } from 'react';
import { PANELS, type Preset, type useLayoutPrefs } from '../shell/layoutPrefs';
import './PanelsSheet.css';

const PRESET_INFO: { id: Preset; label: string; description: string }[] = [
  {
    id: 'simple',
    label: 'Simple',
    description: 'One thing at a time — the map, the status and the token chart.',
  },
  {
    id: 'standard',
    label: 'Standard',
    description: 'Chat list, map and inspector side by side.',
  },
  {
    id: 'everything',
    label: 'Everything',
    description: 'Every panel and the telemetry strip.',
  },
];

const GROUP_ORDER: Array<'Chat' | 'Map & views' | 'Details' | 'Header'> = [
  'Chat',
  'Map & views',
  'Details',
  'Header',
];

export function PanelsSheet({
  open,
  onClose,
  preset,
  onPreset,
  prefs,
}: {
  open: boolean;
  onClose: () => void;
  preset: Preset;
  onPreset: (p: Preset) => void;
  prefs: ReturnType<typeof useLayoutPrefs>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    closeRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        const items = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || !drawerRef.current?.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !drawerRef.current?.contains(document.activeElement))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="ps-root">
      <div className="ps-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={drawerRef}
        className="ps-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ps-title"
      >
        <div className="ps-head">
          <h2 id="ps-title" className="ps-title">
            Panels
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="ps-close"
            aria-label="Close panels"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <p className="ps-intro">
          Show what you need. Nothing is deleted — hidden panels stay listed here.
        </p>

        <div className="ps-presets" role="radiogroup" aria-label="Layout preset">
          {PRESET_INFO.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={preset === p.id}
              className={`ps-preset${preset === p.id ? ' ps-preset-on' : ''}`}
              onClick={() => onPreset(p.id)}
            >
              <span className="ps-preset-label">{p.label}</span>
              <span className="ps-preset-desc">{p.description}</span>
            </button>
          ))}
        </div>

        <div className="ps-groups">
          {GROUP_ORDER.map((group) => {
            const panels = PANELS.filter((p) => p.group === group);
            if (panels.length === 0) return null;
            return (
              <section key={group} className="ps-group" aria-label={group}>
                <h3 className="ps-group-title">{group}</h3>
                {panels.map((panel) => {
                  const on = prefs.visible(panel.id);
                  return (
                    <div key={panel.id} className="ps-row">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={panel.title}
                        className={`ps-switch${on ? ' ps-switch-on' : ''}`}
                        onClick={() => prefs.toggle(panel.id)}
                      >
                        <span className="ps-knob" aria-hidden="true" />
                      </button>
                      <div className="ps-row-text" onClick={() => prefs.toggle(panel.id)}>
                        <div className="ps-row-title">{panel.title}</div>
                        <div className="ps-row-desc">{panel.description}</div>
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>

        <div className="ps-foot">
          <button type="button" className="ps-reset" onClick={prefs.reset}>
            Reset This Layout
          </button>
          <p className="ps-foot-note">
            Puts this preset back to its defaults. Your chat and filters stay.
          </p>
        </div>
      </div>
    </div>
  );
}
