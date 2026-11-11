/**
 * Which problems are new, and what "acknowledge all" remembers.
 *
 * A problem is identified by what makes it the same problem, not by when it happened: the same
 * tool failing the same way twice is one problem the reader has already read. Acknowledging stores
 * those signatures and the moment; anything recorded after that moment is new again.
 */

export interface ProblemLike {
  ts: number | null;
  kind: string;
  tool: string | null;
  error_type: string | null;
  reason: string | null;
  event_id?: string | null;
}

export interface Ack {
  at: number;
  sigs: string[];
}

export function signature(problem: ProblemLike): string {
  return [problem.kind, problem.tool ?? '', problem.error_type ?? '', problem.reason ?? '']
    .join('|')
    .slice(0, 240);
}

export function readAck(raw: string | null): Ack | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Ack>;
    if (typeof parsed.at !== 'number' || !Array.isArray(parsed.sigs)) return null;
    return { at: parsed.at, sigs: parsed.sigs.filter((s): s is string => typeof s === 'string') };
  } catch {
    return null;
  }
}

/** Problems the reader has not acknowledged: a new signature, or a known one that happened after. */
export function unseen<T extends ProblemLike>(problems: T[], ack: Ack | null): T[] {
  if (!ack) return problems;
  const known = new Set(ack.sigs);
  return problems.filter((problem) => {
    const sig = signature(problem);
    if (!known.has(sig)) return true;
    return typeof problem.ts === 'number' && problem.ts > ack.at;
  });
}

/** The acknowledgement to store: every signature now on screen, and now. */
export function acknowledge(problems: ProblemLike[], now: number): Ack {
  const sigs: string[] = [];
  for (const problem of problems) {
    const sig = signature(problem);
    if (!sigs.includes(sig)) sigs.push(sig);
  }
  return { at: now, sigs: sigs.slice(-80) };
}
