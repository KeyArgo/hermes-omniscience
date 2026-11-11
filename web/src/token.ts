const TOKEN_KEY = "omni.t";

let memoryToken: string | null = null;

function readSearchToken(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("t");
  } catch {
    return null;
  }
}

function readSessionToken(): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeSessionToken(token: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore
  }
}

const initial = readSearchToken();
if (initial) {
  memoryToken = initial;
  writeSessionToken(initial);
  // The token only needed to cross the browser trust boundary once, in the page URL.
  // Strip it immediately so it never lingers in history, referrers or the address bar.
  try {
    if (typeof window !== "undefined" && window.history && window.history.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete("t");
      window.history.replaceState(window.history.state, "", url.toString());
    }
  } catch {
    // ignore
  }
}

// The viewer writes its current key into the page it serves this machine (app.py,
// `_inject_key`). It is the freshest truth, so it wins over a token left in sessionStorage
// by an earlier launch — which is what makes a plain reload recover a rotated key.
function readInjectedToken(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const value = (window as { __OMNI_TOKEN__?: unknown }).__OMNI_TOKEN__;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

const injected = readInjectedToken();
if (injected) {
  memoryToken = injected;
  writeSessionToken(injected);
}

const RECOVERED_AT_KEY = "omni.keyRecoveredAt";

/**
 * A key rotated under an open tab leaves every call answering 401 and the page dead.
 * One reload picks the current key out of the freshly served page, so the viewer heals
 * itself instead of asking the user to find a new link. Guarded to one attempt per 30s
 * so a genuinely unreachable viewer cannot reload-loop.
 */
export function recoverStaleKey(): boolean {
  try {
    if (typeof window === "undefined" || typeof sessionStorage === "undefined") return false;
    const last = Number(sessionStorage.getItem(RECOVERED_AT_KEY) || "0");
    if (Number.isFinite(last) && Date.now() - last < 30000) return false;
    sessionStorage.setItem(RECOVERED_AT_KEY, String(Date.now()));
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

export function viewerToken(): string | null {
  if (memoryToken) return memoryToken;
  const stored = readSessionToken();
  if (stored) {
    memoryToken = stored;
    return stored;
  }
  return null;
}

export function tokenHeaders(): Record<string, string> {
  const token = viewerToken();
  if (!token) return {};
  return { "x-omni-token": token };
}

export function withToken(url: string): string {
  // The token is carried in the X-Omni-Token header (HTTP) and the omni.<token>
  // WebSocket subprotocol — never in the URL — so it cannot leak into browser
  // history, referrers or access logs. The URL itself is returned unchanged.
  return url;
}

/** The subprotocol the live socket proposes so the token never sits in the URL query. */
export function wsSubprotocol(): string | null {
  const token = viewerToken();
  return token ? `omni.${token}` : null;
}
