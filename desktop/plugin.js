/**
 * Omniscience desktop page: embeds the standalone viewer (graph + replay) as a Hermes page
 * with a row in the left sidebar. The viewer runs separately on 127.0.0.1:8797.
 */
import { host } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const VIEWER_URL = 'http://127.0.0.1:8797'

// /omni links carry ?session=<id>; the router may keep the query in the hash.
function linkedSession() {
  const fromQuery = query => new URLSearchParams(query).get('session')
  const hash = window.location.hash || ''
  const at = hash.indexOf('?')
  return fromQuery(window.location.search) || (at >= 0 ? fromQuery(hash.slice(at)) : null)
}

function focusedChat() {
  try {
    const state = host.state || {}
    return state.focusedStoredSessionId?.get?.() || state.activeSessionId?.get?.() || null
  } catch {
    return null
  }
}

// The embedded viewer asks us to open itself in the user's browser (its own window.open is blocked).
// Only links back to the viewer itself are honoured.
let externalListener = null
function listenForOpenExternal() {
  if (externalListener) return
  externalListener = event => {
    const data = event.data
    if (event.origin !== VIEWER_URL || !data) return
    if (data.type === 'omniscience:open-full') {
      const session = typeof data.session === 'string' ? data.session : null
      host.navigate(session ? `/omniscience?session=${encodeURIComponent(session)}` : '/omniscience')
      return
    }
    if (data.type === 'omniscience:toggle-pane') {
      setPane(!paneWanted())
      return
    }
    if (data.type !== 'omniscience:open-external') return
    if (typeof data.url !== 'string' || !data.url.startsWith(VIEWER_URL + '/')) return
    CTX?.os?.openExternal?.(data.url)
  }
  window.addEventListener('message', externalListener)
}

let CTX = null

// The viewer only answers with its per-launch key; Hermes hands it to us behind its own login.
// Read it straight from disk through the desktop file bridge (works in every profile, no gateway
// round trip); fall back to the plugin's Hermes route. The key belongs to the focused profile's
// viewer, so resolve that profile's token first and only fall back to the default profile.
async function readKeyFromDisk() {
  const d = window.hermesDesktop
  const rootFn = d?.desktopPluginsRoot || d?.fs?.desktopPluginsRoot
  if (!d?.readFileText || !rootFn) return null
  const root = String((await rootFn()) || '')
  const home = root.replace(/[\\/]desktop-plugins[\\/]?$/, '')
  if (!home) return null
  let profile = null
  try {
    profile = host.state?.focusedSessionProfile?.get?.() || null
  } catch {
    profile = null
  }
  const candidates = []
  if (profile && profile !== 'default') candidates.push(`${home}/profiles/${profile}/plugin-data/omniscience/viewer-token`)
  candidates.push(`${home}/plugin-data/omniscience/viewer-token`)
  for (const path of candidates) {
    try {
      const file = await d.readFileText(path)
      const token = String(file?.text || '').trim()
      if (token) return token
    } catch {
      /* try the next place */
    }
  }
  return null
}

async function viewerReachable() {
  try {
    await fetch(`${VIEWER_URL}/api/v1/ping`, { mode: 'no-cors', cache: 'no-store' })
    return true
  } catch {
    return false
  }
}

function useViewerKey() {
  const [state, setState] = useState({ ready: false, token: null, up: true, attempt: 0 })
  useEffect(() => {
    let alive = true
    ;(async () => {
      const up = await viewerReachable()
      let token = null
      if (up) {
        token = await readKeyFromDisk().catch(() => null)
        if (!token && CTX?.rest) token = await Promise.resolve(CTX.rest('/viewer')).then(r => (r && r.token) || null).catch(() => null)
      }
      if (alive) setState(prev => ({ ...prev, ready: true, token, up }))
    })()
    return () => {
      alive = false
    }
  }, [state.attempt])
  const retry = () => setState(prev => ({ ...prev, ready: false, attempt: prev.attempt + 1 }))
  return { ...state, retry }
}

function ViewerProblem({ up, retry }) {
  const text = up
    ? 'Omniscience could not get the viewer key. Restart the viewer, then retry.'
    : 'The Omniscience viewer is not running. Start it (python -m omniscience_viewer), then retry.'
  return jsx('div', {
    style: { padding: 24, maxWidth: 560, lineHeight: 1.5 },
    children: [
      jsx('p', { key: 't', style: { marginBottom: 12 }, children: text }),
      jsx('button', { key: 'b', onClick: retry, style: { padding: '6px 14px', cursor: 'pointer' }, children: 'Retry' }),
    ],
  })
}

function viewerSrc(session, token, extra) {
  const params = new URLSearchParams(extra || {})
  if (session) params.set('session', session)
  if (token) params.set('t', token)
  const query = params.toString()
  return query ? `${VIEWER_URL}/?${query}` : VIEWER_URL
}

function OmnisciencePage() {
  listenForOpenExternal()
  const key = useViewerKey()
  // Default to the chat the user was in when they opened Omniscience.
  const session = linkedSession() || focusedChat()
  if (!key.ready) return jsx('div', { style: { padding: 16, opacity: 0.6 }, children: 'Opening Omniscience…' })
  if (!key.up || !key.token) return jsx(ViewerProblem, { up: key.up, retry: key.retry })
  const src = viewerSrc(session, key.token)
  return jsx('div', {
    style: { width: '100%', height: '100%', display: 'flex' },
    children: jsx('iframe', {
      src,
      title: 'Omniscience viewer',
      allow: 'fullscreen',
      allowFullScreen: true,
      style: { flex: 1, border: 'none', display: 'block' },
    }),
  })
}

// Docked live pane next to the chat: follows whichever chat is focused.
function useFocusedChat() {
  const [session, setSession] = useState(focusedChat())
  useEffect(() => {
    const atom = host.state?.focusedStoredSessionId
    if (!atom?.listen) return
    return atom.listen(value => setSession(value || null))
  }, [])
  return session
}

function LivePane() {
  listenForOpenExternal()
  const key = useViewerKey()
  const session = useFocusedChat()
  if (!key.ready) return jsx('div', { style: { padding: 12, opacity: 0.6 }, children: 'Opening…' })
  if (!key.up || !key.token) return jsx(ViewerProblem, { up: key.up, retry: key.retry })
  // The two actions are drawn by the pane itself and call Hermes directly: messages from the
  // embedded page to its parent do not reliably reach a docked pane.
  const btn = { flex: 1, padding: '6px 8px', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6,
    background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' }
  const fullView = () => host.navigate(session ? `/omniscience?session=${encodeURIComponent(session)}` : '/omniscience')
  const inBrowser = () => CTX?.os?.openExternal?.(viewerSrc(session, key.token))
  return jsx('div', {
    style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%' },
    children: [
      jsx('iframe', {
        key: session || 'none',
        src: viewerSrc(session, key.token, { mini: '1', actions: '0' }),
        title: 'Omniscience live',
        style: { flex: 1, width: '100%', border: 'none', display: 'block' },
      }),
      jsx('div', {
        key: 'actions',
        style: { display: 'flex', gap: 8, padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' },
        children: [
          jsx('button', { key: 'f', type: 'button', style: btn, onClick: fullView, children: 'Open full view' }),
          jsx('button', { key: 'b', type: 'button', style: btn, onClick: inBrowser, children: 'Open in browser ↗' }),
        ],
      }),
    ],
  })
}

const PANE_KEY = 'omniscience.livePane'
let paneDisposer = null
// On by default: the pane shows the current chat as it happens. Closing it (button or palette)
// is remembered.
function paneWanted() {
  try {
    return window.localStorage.getItem(PANE_KEY) !== '0'
  } catch {
    return true
  }
}
function setPane(on) {
  try {
    window.localStorage.setItem(PANE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
  if (paneDisposer) {
    try {
      paneDisposer()
    } catch {
      /* already gone */
    }
    paneDisposer = null
  }
  if (!on || !CTX) return
  try {
    paneDisposer = CTX.register({
      id: 'live-pane',
      area: 'panes',
      title: 'Omniscience live',
      data: { placement: 'right', dock: { pane: 'workspace', pos: 'right' }, width: '300px' },
      render: () => jsx(LivePane, {}),
    })
  } catch {
    paneDisposer = null
  }
}

export default {
  id: 'omniscience',
  name: 'Omniscience',
  register(ctx) {
    CTX = ctx
    ctx.register({
      id: 'page',
      area: 'routes',
      title: 'Omniscience',
      data: { path: '/omniscience' },
      render: () => jsx(OmnisciencePage, {}),
    })

    ctx.register({
      id: 'nav',
      area: 'sidebar.nav',
      data: { path: '/omniscience', label: 'Omniscience', codicon: 'eye' },
    })

    ctx.register({
      id: 'toggle-pane',
      area: 'palette',
      data: {
        id: 'omniscience.toggleLivePane',
        label: 'Omniscience: Show/hide live pane next to the chat',
        keywords: ['omniscience', 'omni', 'live', 'pane', 'wireshark', 'watch'],
        run: () => setPane(!paneWanted()),
      },
    })
    setPane(paneWanted())

    ctx.register({
      id: 'open',
      area: 'palette',
      data: {
        id: 'omniscience.open',
        label: 'Omniscience: Open activity graph',
        keywords: ['omniscience', 'omni', 'graph', 'replay', 'activity'],
        run: () => host.navigate('/omniscience'),
      },
    })
  },
}
