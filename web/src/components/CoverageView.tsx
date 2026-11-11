import { useMemo } from "react";
import type { OmniEvent } from "../types";
import { buildCoverage } from "../graph/coverage";
import "./CoverageView.css";

export interface CoverageViewProps {
  events: OmniEvent[];
  loadedAll: boolean;
}

interface ChecklistItem {
  label: string;
  ok: boolean;
  detail: string;
}

export function CoverageView({ events, loadedAll }: CoverageViewProps) {
  const coverage = useMemo(
    () => buildCoverage(events, loadedAll),
    [events, loadedAll],
  );

  const checklist: ChecklistItem[] = [
    {
      label: "All events loaded",
      ok: loadedAll,
      detail: loadedAll
        ? "The full recording is loaded."
        : "Only the newest events are loaded; totals cover what is loaded.",
    },
    {
      label: "No skipped steps",
      ok: coverage.dropped === 0,
      detail:
        coverage.dropped === 0
          ? "The recorder kept up with every step."
          : `The recorder fell behind and skipped ${coverage.dropped} ${
              coverage.dropped === 1 ? "step" : "steps"
            }.`,
    },
    {
      label: "Every model call has an answer",
      ok: coverage.unpairedRequests === 0,
      detail:
        coverage.unpairedRequests === 0
          ? "All model calls have a recorded answer."
          : `${coverage.unpairedRequests} model ${
              coverage.unpairedRequests === 1 ? "call has" : "calls have"
            } no recorded answer (the chat may have been stopped).`,
    },
    {
      label: "Every answer has a request",
      ok: coverage.unpairedResponses === 0,
      detail:
        coverage.unpairedResponses === 0
          ? "All recorded answers match a request."
          : `${coverage.unpairedResponses} model ${
              coverage.unpairedResponses === 1 ? "answer has" : "answers have"
            } no matching request in the loaded events.`,
    },
    {
      label: "Every turn has an end",
      ok: coverage.turnsWithoutEnd === 0,
      detail:
        coverage.turnsWithoutEnd === 0
          ? "All turns have a recorded end."
          : `${coverage.turnsWithoutEnd} ${
              coverage.turnsWithoutEnd === 1 ? "turn has" : "turns have"
            } no recorded end (the chat may have been stopped).`,
    },
    {
      label: "Token usage recorded",
      ok: coverage.usageMissing === 0,
      detail:
        coverage.usageMissing === 0
          ? "All model answers include token usage."
          : `${coverage.usageMissing} model ${
              coverage.usageMissing === 1 ? "answer is" : "answers are"
            } missing token usage details.`,
    },
  ];

  return (
    <div className="cv-root">
      <div className="cv-header">
        <h2 className="cv-title">Recording coverage</h2>
        <span
          className={
            coverage.complete ? "cv-badge cv-badge-ok" : "cv-badge cv-badge-warn"
          }
        >
          {coverage.complete ? "Complete" : "Partial"}
        </span>
      </div>

      <p className="cv-intro">
        This shows how complete the recording is. When something is missing,
        totals on other panels may be partial.
      </p>

      <ul className="cv-checklist">
        {checklist.map((item) => (
          <li key={item.label} className="cv-check-item">
            <span
              className={item.ok ? "cv-mark cv-mark-ok" : "cv-mark cv-mark-warn"}
              aria-hidden="true"
            >
              {item.ok ? "✓" : "⚠"}
            </span>
            <div className="cv-check-body">
              <div className="cv-check-label">{item.label}</div>
              <div className="cv-check-detail">{item.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      {coverage.notes.length > 0 && (
        <div className="cv-notes">
          <div className="cv-notes-title">Notes</div>
          <ul className="cv-notes-list">
            {coverage.notes.map((note, i) => (
              <li key={i} className="cv-note">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="cv-kinds">
        <div className="cv-kinds-title">Recorded event kinds</div>
        {coverage.kinds.length === 0 ? (
          <div className="cv-empty">No events recorded.</div>
        ) : (
          <table className="cv-table">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col" className="cv-num">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              {coverage.kinds.map((k) => (
                <tr key={k.kind}>
                  <td className="cv-kind">{k.kind}</td>
                  <td className="cv-num">{k.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
