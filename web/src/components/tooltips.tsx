import type { ReactNode } from 'react';

/**
 * Minimal tooltip wrapper: native title (works for keyboard and screen readers)
 * on a span, because some hosts (e.g. status dots, legend items) cannot hold a
 * title attribute themselves.
 */
export function NodeTooltip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="tip" title={text}>
      {children}
    </span>
  );
}

/** Tooltip strings, one plain sentence each. */
export const TIPS = {
  statusBox: (status: string): string => {
    switch (status) {
      case 'ok':
      case 'completed':
        return 'Done OK: this step finished without failing.';
      case 'running':
        return 'Running: this step is in progress right now.';
      case 'error':
      case 'failed':
        return 'Failed: this step went wrong — click it for details.';
      case 'interrupted':
        return 'Interrupted: the run was stopped part way through this step.';
      case 'blocked':
        return 'Blocked: this step could not proceed.';
      case 'cancelled':
        return 'Cancelled: this step was cancelled.';
      case 'lost':
        return 'Lost: steps the recorder had to skip because it fell behind. The map shows where.';
      default:
        return 'No status was recorded for this step.';
    }
  },
  kindBox: (kind: string): string => {
    switch (kind) {
      case 'session':
        return 'Session: one conversation with your agent.';
      case 'turn':
        return 'Turn: one message from you, plus everything the agent did about it.';
      case 'llm':
        return 'Model call: the agent asking the AI model. Tokens are the amount of text sent and received.';
      case 'tool':
        return 'Tool: an action like running a command or reading a file.';
      case 'gap':
        return 'Lost: steps the recorder had to skip because it fell behind. The map shows where.';
      default:
        return 'A step in the run.';
    }
  },
};

/** Status texts used by the inspector / summary in plain words. */
export const STATUS_WORDS: Record<string, string> = {
  ok: 'Finished OK',
  completed: 'Completed',
  running: 'Still running',
  error: 'Failed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  lost: 'Steps not recorded',
  unknown: 'No status recorded',
};
