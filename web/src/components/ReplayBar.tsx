export type Speed = 1 | 4 | 16;

export interface ReplayBarProps {
  total: number;
  index: number | null;
  playing: boolean;
  speed: Speed;
  onIndex: (index: number | null) => void;
  onTogglePlay: () => void;
  onSpeed: (speed: Speed) => void;
  onLive: () => void;
}

const SPEEDS: Speed[] = [1, 4, 16];

export function ReplayBar({
  total,
  index,
  playing,
  speed,
  onIndex,
  onTogglePlay,
  onSpeed,
  onLive,
}: ReplayBarProps) {
  const position = index ?? total;
  const live = index === null;

  return (
    <footer className="replay-bar">
      <button
        type="button"
        className="transport"
        onClick={onTogglePlay}
        disabled={total === 0}
        aria-label={playing ? 'pause replay' : 'play replay'}
        title={
          total === 0
            ? 'Nothing recorded yet — replay will appear once your agent does something.'
            : 'Replay: walk through the recorded run step by step. It only redraws what was recorded — it never re-runs anything.'
        }
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <span
        className={`replay-mode ${live ? 'is-live' : ''}`}
        title={live ? 'Live: the map is showing the newest recorded steps.' : 'Replay: you are watching recorded steps.'}
      >
        {live ? 'LIVE' : 'REPLAY'}
      </span>
      <span
        className="mono replay-pos"
        title="How many of the recorded steps are drawn on the map."
      >
        {position} / {total}
      </span>
      <input
        className="replay-range"
        type="range"
        min={0}
        max={Math.max(total, 0)}
        step={1}
        value={position}
        disabled={total === 0}
        aria-label="replay position"
        title="Drag to rewind or fast-forward the recorded run. Nothing is re-run."
        onChange={(event) => {
          const next = Number(event.target.value);
          onIndex(next >= total ? null : next);
        }}
      />
      <div className="speed-group" role="group" aria-label="replay speed">
        {SPEEDS.map((value) => (
          <button
            type="button"
            key={value}
            className={`speed ${speed === value ? 'is-active' : ''}`}
            onClick={() => onSpeed(value)}
            title={`Replay ${value} step${value === 1 ? '' : 's'} per tick.`}
          >
            {value}×
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`live-button ${live ? 'is-active' : ''}`}
        onClick={onLive}
        title="Jump back to the newest recorded steps (leave replay)."
      >
        Live
      </button>
    </footer>
  );
}
