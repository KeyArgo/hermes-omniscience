import type { PressureAdvice } from "../graph/pressure";
import { Tip } from "./Tip";

function thousands(n: number): string {
  return Math.round(n).toLocaleString();
}

/**
 * The cost warning: how much every message in this chat currently re-sends, and
 * whether compacting would meaningfully cut it.
 *
 * It never invents money. The numbers shown are the ones the provider reported.
 */
export function PressureBanner({
  advice,
  onCompact,
}: {
  advice: PressureAdvice;
  onCompact?: () => void;
}) {
  const level = advice.level;
  return (
    <section
      className={`pr-banner pr-${level}`}
      aria-label={
        level === "compact"
          ? "This chat is expensive: compact it"
          : level === "watch"
            ? "This chat is getting expensive"
            : "Token cost of this chat"
      }
    >
      <div className="pr-head">
        <span className={`pr-mark pr-mark-${level}`} aria-hidden="true" />
        <span className="pr-headline">{advice.headline}</span>
        {level !== "ok" ? (
          <Tip
            text="A context compaction replaces the old part of the conversation with a short summary, so the next messages send less input. It costs one extra model call to summarise, and the provider cache starts over."
            side="left"
            wide
          >
            <span className="pr-why">why?</span>
          </Tip>
        ) : null}
      </div>
      <p className="pr-message">{advice.message}</p>
      {level !== "ok" ? (
        <>
          <dl className="pr-facts">
            <div>
              <dt>now</dt>
              <dd title="Input tokens the newest model call sent">{thousands(advice.nowPrompt)}</dd>
            </div>
            <div>
              <dt>peak</dt>
              <dd title="The biggest prompt this chat ever sent">{thousands(advice.peakPrompt)}</dd>
            </div>
            <div>
              <dt>new per call</dt>
              <dd title="Average input that was not cached, over the last 10 calls">
                {thousands(advice.freshPerCall)}
              </dd>
            </div>
            <div>
              <dt>from cache</dt>
              <dd title="Share of the newest call's input the provider served from its cache">
                {advice.cacheShare === null ? "—" : `${Math.round(advice.cacheShare * 100)}%`}
              </dd>
            </div>
            <div>
              <dt>compactions</dt>
              <dd title="How many times this chat's context has already been compacted">
                {advice.compactionsSeen}
              </dd>
            </div>
          </dl>
          {onCompact ? (
            <button type="button" className="pr-action" onClick={onCompact}>
              show me the calls
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
