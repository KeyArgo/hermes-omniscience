/** Human-readable names for event types; unfamiliar types stay visible as recorded. */
export function eventKindLabel(kind: string): string {
  const names: Record<string, string> = {
    'session.start': 'Session started',
    'session.end': 'Session ended',
    'turn.start': 'Turn started',
    'turn.end': 'Turn ended',
    'llm.request': 'Model request',
    'llm.response': 'Model response',
    'llm.error': 'Model error recorded',
    'tool.end': 'Tool call ended',
    'subagent.start': 'Helper agent started',
    'subagent.stop': 'Helper agent stopped',
    'omni.dropped': 'Events lost',
  };
  return names[kind] ?? kind;
}
