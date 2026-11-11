/**
 * Which tool runs deserve the reader's attention, and how loudly.
 *
 * The recorder sees a tool name and a few numbers — never the arguments' text mutating anything —
 * so this classifies by name plus counts that are already recorded. High tone means "a person or a
 * machine is being driven": a browser, a desktop, or a wide sweep of files. Low tone means the run
 * touched the outside world or a third-party server, which is worth a mention, not an alarm.
 */

export type RiskClass = 'browser' | 'computer' | 'grep-broad' | 'network' | 'mcp';

export interface RiskHit {
  cls: RiskClass;
  /** What the reader sees, e.g. "Browser use". */
  label: string;
  tone: 'high' | 'low';
}

const BROWSER = /browser|playwright|chromium|puppeteer|selenium/i;
const COMPUTER = /computer[_ -]?use|screenshot|screen_?capture|mouse_?click|key_?press|xdotool/i;
const SWEEP = /(^|_|\b)grep\b|search_?files|ripgrep|glob_?search/i;
const NETWORK = /web_?search|web_?extract|http|fetch|curl|wget|download/i;
const MCP = /^mcp__|^mcp[.:]/i;

const LABELS: Record<RiskClass, string> = {
  browser: 'Browser use',
  computer: 'Computer use',
  'grep-broad': 'Wide file sweep',
  network: 'Network call',
  mcp: 'MCP server',
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function countOf(attrs: Record<string, unknown> | undefined): number | null {
  if (!attrs) return null;
  for (const key of ['files', 'file_count', 'files_searched', 'paths_count']) {
    const n = num(attrs[key]);
    if (n !== null) return n;
  }
  for (const key of ['paths', 'files_list']) {
    const value = attrs[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

/** Classify one tool run. `null` means: nothing private about it. */
export function riskOf(toolName: string, attrs?: Record<string, unknown>): RiskHit | null {
  const name = toolName.trim();
  if (!name) return null;

  if (MCP.test(name)) return { cls: 'mcp', label: LABELS.mcp, tone: 'low' };
  if (COMPUTER.test(name)) return { cls: 'computer', label: LABELS.computer, tone: 'high' };
  if (BROWSER.test(name)) return { cls: 'browser', label: LABELS.browser, tone: 'high' };
  if (SWEEP.test(name)) {
    const files = countOf(attrs);
    // A sweep of more than five files is a search of your disk, not a read of one thing.
    if (files !== null && files > 5) return { cls: 'grep-broad', label: LABELS['grep-broad'], tone: 'high' };
    return null;
  }
  if (NETWORK.test(name)) return { cls: 'network', label: LABELS.network, tone: 'low' };
  return null;
}

/** The loudest hit in a list, or null. High tone wins over low. */
export function strongest(hits: RiskHit[]): RiskHit | null {
  return hits.find((hit) => hit.tone === 'high') ?? hits[0] ?? null;
}
