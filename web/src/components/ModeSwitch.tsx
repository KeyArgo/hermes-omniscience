import type { InterfaceMode } from '../shell/mode';

const OPTIONS: { id: InterfaceMode; label: string; title: string }[] = [
  {
    id: 'hermes',
    label: 'Hermes',
    title:
      'Hermes mode: the readable layout for the pane beside your chat. Starts Simple, with large controls; the full workspace is one press away.',
  },
  {
    id: 'web',
    label: 'Web',
    title:
      'Web mode: the full workspace — chat list, map, inspector and every view. Remembers its own layout.',
  },
];

/**
 * The interface mode, stated rather than hidden in a menu. Two pressed-state buttons in a named
 * group: keyboard reaches both, and a screen reader hears which one is current without relying on
 * colour. It only chooses the layout; every feature stays reachable in either mode.
 */
export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: InterfaceMode;
  onChange: (mode: InterfaceMode) => void;
}) {
  return (
    <div className="mode-select" role="group" aria-label="Interface mode">
      <span className="mode-select-label" aria-hidden="true">
        Mode
      </span>
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`mode-option${mode === option.id ? ' is-active' : ''}`}
          aria-pressed={mode === option.id}
          data-mode-option={option.id}
          onClick={() => onChange(option.id)}
          title={option.title}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
