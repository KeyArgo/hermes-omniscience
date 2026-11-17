import type { Preset } from '../shell/layoutPrefs';

const OPTIONS: { id: Preset; label: string; title: string }[] = [
  { id: 'simple', label: 'Simple', title: 'Simple: one thing at a time — the map, the status card and the token chart.' },
  { id: 'standard', label: 'Standard', title: 'Standard: chat list, map and details side by side.' },
  { id: 'everything', label: 'Everything', title: 'Everything: every panel and the telemetry strip.' },
];

/**
 * How much is on screen, from lite to everything, as one stated three-way choice beside Mode.
 * The same presets as Actions → Panels, where single panels can still be shown or hidden.
 */
export function DetailSwitch({
  preset,
  onChange,
  placement,
}: {
  preset: Preset;
  onChange: (preset: Preset) => void;
  /** The header's status row on wide windows, the Workspace sheet on narrow ones. */
  placement: 'bar' | 'sheet';
}) {
  return (
    <div className={`mode-select detail-select detail-in-${placement}`} role="group" aria-label="How much detail">
      <span className="mode-select-label" aria-hidden="true">
        Detail
      </span>
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`mode-option${preset === option.id ? ' is-active' : ''}`}
          aria-pressed={preset === option.id}
          data-detail-option={option.id}
          onClick={() => onChange(option.id)}
          title={option.title}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
