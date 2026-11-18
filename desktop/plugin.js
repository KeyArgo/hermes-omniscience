/**
 * Omniscience desktop page: embeds the standalone viewer (graph + replay) as a Hermes page
 * with a row in the left sidebar. The viewer runs separately on 127.0.0.1:8797.
 */
import { host, SandboxedFrame } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

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
//
// Origins: the page is embedded in the SDK's SandboxedFrame, so its origin is OPAQUE and arrives
// as the string "null" — the viewer URL is what a browser tab reports, and both are the page we
// embedded. Everything else is ignored, and the payload is validated below regardless.
//
// The viewer key never travels in a message: the page names only the chat and the view, and this
// page builds the link from its own copy of the key. A reply says whether Hermes opened it, and
// carries nothing secret (it has to be sent to "*" because the frame's origin is opaque).
const VIEWER_ORIGINS = new Set([VIEWER_URL, 'null'])
const SESSION_RE = /^[A-Za-z0-9_.:-]{1,200}$/
const VIEW_RE = /^[a-z]{1,24}$/
let viewerToken = null
let externalListener = null

export function browserLinkFor(data, token) {
  if (!token) return null
  const session = typeof data?.session === 'string' && SESSION_RE.test(data.session) ? data.session : null
  const view = typeof data?.view === 'string' && VIEW_RE.test(data.view) ? data.view : null
  return viewerSrc(session, token, view ? { host: 'web', view } : { host: 'web' })
}

export function handleViewerMessage(event) {
  const data = event.data
  if (!VIEWER_ORIGINS.has(event.origin) || !data || typeof data !== 'object') return
  if (data.type === 'omniscience:open-full') {
    const session = typeof data.session === 'string' ? data.session : null
    host.navigate(session ? `/omniscience?session=${encodeURIComponent(session)}` : '/omniscience')
    return
  }
  if (data.type === 'omniscience:toggle-pane') {
    setPane(!paneWanted())
    return
  }
  if (data.type !== 'omniscience:open-web') return
  const requestId = typeof data.requestId === 'string' ? data.requestId.slice(0, 64) : ''
  const reply = ok => {
    try {
      event.source?.postMessage?.({ type: 'omniscience:open-web-result', requestId, ok }, '*')
    } catch {
      /* the frame went away */
    }
  }
  const url = browserLinkFor(data, viewerToken)
  const open = CTX?.os?.openExternal
  if (!url || typeof open !== 'function') {
    reply(false)
    return
  }
  Promise.resolve()
    .then(() => CTX.os.openExternal(url))
    .then(ok => reply(ok !== false), () => reply(false))
}

function listenForOpenExternal() {
  if (externalListener) return
  externalListener = handleViewerMessage
  window.addEventListener('message', externalListener)
}

let CTX = null
const ROOM_KEY = 'makeRoomAutomatically'
let roomCleanup = null
let roomClosing = false
let roomAfterClosing = null

function roomWanted(ctx) {
  try {
    if (ctx?.storage) return ctx.storage.get(ROOM_KEY, true) !== false
    return window.localStorage.getItem('omniscience.' + ROOM_KEY) !== '0'
  } catch {
    return false
  }
}

function setRoomWanted(ctx, on) {
  try {
    if (ctx?.storage) ctx.storage.set(ROOM_KEY, on)
    else window.localStorage.setItem('omniscience.' + ROOM_KEY, on ? '1' : '0')
  } catch { /* storage unavailable */ }
}

function RoomSettings() {
  const [on, setOn] = useState(roomWanted(CTX))
  return jsx('label', { style: { display: 'flex', gap: 8, padding: 16 }, children: [
    jsx('input', { key: 'input', type: 'checkbox', checked: on, onChange: event => {
      const next = event.target.checked
      setRoomWanted(CTX, next)
      setOn(next)
    } }),
    'Make room automatically',
  ] })
}

// The shell unmounts the status bar when disabled. A missing shell is unknown,
// not evidence that the bar is hidden (for example, during disposal).
function statusbarVisible() {
  const shell = document.querySelector('[data-contrib-shell]')
  return shell ? Boolean(shell.querySelector('[data-slot="statusbar"]')) : null
}

function sidebarLabel(side) {
  // The host emits no tool id. The right tool has a tour marker; the left tool
  // is the sidebar glyph in the fixed left cluster.
  const selector = side === 'left'
    ? '[data-titlebar-cluster="left"] button:has(.codicon-layout-sidebar-left)'
    : 'button[data-tour="right-pane-toggle"]'
  return document.querySelector(selector)?.getAttribute('aria-label') || null
}

function afterHostCommit() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

// Wait for the host to commit, then until the page width holds still for a frame (at most half a
// second), so a slow machine or an animated pane is not mistaken for "nothing moved".
async function settled(element) {
  await afterHostCommit()
  const end = Date.now() + 500
  let last = element?.getBoundingClientRect().width
  while (Date.now() < end) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const width = element?.getBoundingClientRect().width
    if (width === last) return
    last = width
  }
}

function makeRoom(ctx, page) {
  if (!roomWanted(ctx) || typeof ctx?.runAction !== 'function') return () => {}
  if (roomCleanup) {
    if (!roomClosing) return () => {}
    let cancelled = false
    let nextCleanup = null
    roomAfterClosing = () => { if (!cancelled) nextCleanup = makeRoom(ctx, page) }
    return () => { cancelled = true; nextCleanup?.() }
  }
  const hidden = statusbarVisible() === true && ctx.runAction('view.toggleStatusbar')?.ok === true
  const sides = []
  let active = true
  let pending = true
  // Put back what this page hid even if the preference was switched off meanwhile; the preference
  // only decides whether to make room on the way in.
  const restoreSides = () => {
    for (const { side, action, label } of sides.splice(0)) {
      if (sidebarLabel(side) === label) ctx.runAction(action)
    }
  }
  const cleanup = () => {
    if (!active) return
    active = false
    roomClosing = pending
    if (hidden && statusbarVisible() === false) ctx.runAction('view.toggleStatusbar')
    restoreSides()
    if (!pending) roomCleanup = null
  }
  roomCleanup = cleanup
  ;(async () => {
    for (const [side, action] of [['left', 'view.toggleSidebar'], ['right', 'view.toggleRightSidebar']]) {
      if (!active || !roomWanted(ctx)) break
      const element = page.current
      const beforeLabel = sidebarLabel(side)
      const before = element?.getBoundingClientRect().width
      if (!beforeLabel || !Number.isFinite(before) || before <= 0) continue
      if (ctx.runAction(action)?.ok !== true) continue
      await settled(element)
      const after = element.getBoundingClientRect().width
      const label = sidebarLabel(side)
      if (Number.isFinite(after) && after - before >= 40 && label && label !== beforeLabel) {
        sides.push({ side, action, label })
      } else {
        // Revert a probe that opened a side or could not be identified safely.
        ctx.runAction(action)
        await afterHostCommit()
      }
      if (!active) restoreSides()
    }
    pending = false
    if (!active) {
      roomCleanup = null
      roomClosing = false
      const restart = roomAfterClosing
      roomAfterClosing = null
      restart?.()
    }
  })()
  return cleanup
}

// The viewer answers only with its per-launch key, and Hermes hands it to us behind its own
// login: the plugin's own backend reads it (GET /api/plugins/omniscience/viewer) and ctx.rest is
// the only door to that namespace. The page must not read plugin-data itself — a file path it
// can reach is a path that can reach another profile's folders, and the tracker above would not
// see the read.
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
      // Ask for the link first: the backend restarts a stopped viewer before it answers, so a viewer
      // that went down with a short-lived Hermes process comes back when this page opens or retries.
      let token = null
      if (CTX?.rest) {
        token = await Promise.resolve(CTX.rest('/viewer')).then(r => (r && r.token) || null).catch(() => null)
      }
      const up = await viewerReachable()
      if (token) viewerToken = token
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
    : 'The Omniscience viewer is not running and could not be started. Retry; if it stays down, see viewer.log in the Omniscience data folder.'
  return jsx('div', {
    style: { padding: 24, maxWidth: 560, lineHeight: 1.5 },
    children: [
      jsx('p', { key: 't', style: { marginBottom: 12 }, children: text }),
      jsx('button', { key: 'b', onClick: retry, style: { padding: '6px 14px', cursor: 'pointer' }, children: 'Retry' }),
    ],
  })
}

// The viewer is told which host it is in, explicitly: `?host=hermes`. It must not guess from
// being framed, because a browser tab and any other embed are web mode. The marker travels in the
// src so it survives reloads and the page can keep per-mode layout preferences apart.
const HOST_MARKER = { host: 'hermes' }

function viewerSrc(session, token, extra) {
  const params = new URLSearchParams(extra || {})
  if (session) params.set('session', session)
  if (token) params.set('t', token)
  const query = params.toString()
  return query ? `${VIEWER_URL}/?${query}` : VIEWER_URL
}

function OmnisciencePage() {
  listenForOpenExternal()
  const page = useRef(null)
  useEffect(() => makeRoom(CTX, page), [])
  const key = useViewerKey()
  // Default to the chat the user was in when they opened Omniscience.
  const session = linkedSession() || focusedChat()
  const src = key.ready && key.up && key.token ? viewerSrc(session, key.token, HOST_MARKER) : null
  return jsx('div', {
    ref: page,
    style: { width: '100%', height: '100%', display: 'flex' },
    // SandboxedFrame, not a raw <iframe>: the viewer is web content, so it gets the app's guest
    // posture (an opaque origin, no bridge, no access to the app's storage). The page is built
    // for that — it authenticates every call with its own key and asks for nothing else.
    children: !key.ready ? jsx('div', { style: { padding: 16, opacity: 0.6 }, children: 'Opening Omniscience…' })
      : !src ? jsx(ViewerProblem, { up: key.up, retry: key.retry })
      : jsx(SandboxedFrame, {
      src,
      title: 'Omniscience viewer',
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
      jsx(SandboxedFrame, {
        key: session || 'none',
        src: viewerSrc(session, key.token, { ...HOST_MARKER, mini: '1', actions: '0' }),
        title: 'Omniscience live',
        style: { flex: 1, width: '100%', border: 'none', display: 'block' },
      }),
      jsx('div', {
        key: 'actions',
        style: { display: 'flex', gap: 8, padding: 8, borderTop: '1px solid rgba(255,255,255,0.08)' },
        children: [
          jsx('button', { key: 'f', type: 'button', style: btn, onClick: fullView, children: 'Open full view' }),
          jsx('button', { key: 'b', type: 'button', style: btn, onClick: inBrowser, children: 'Open in browser ↗' }),
        jsx('button', { key: 'c', type: 'button', style: btn, onClick: () => setPane(false), children: 'Close pane' }),
        ],
      }),
    ],
  })
}

// The previous live pane opened globally by default and could occupy space in other apps.
// A new preference starts closed even if that older default was saved.
const PANE_KEY = 'omniscience.livePane.v2'
let paneDisposer = null
// On by default: the pane shows the current chat as it happens. Closing it (button or palette)
// is remembered.
function paneWanted() {
  try {
    return window.localStorage.getItem(PANE_KEY) === '1'
  } catch {
    return false
  }
}
function setPane(on) {
  if (paneDisposer) {
    const dispose = paneDisposer
    paneDisposer = null
    try {
      dispose()
    } catch {
      /* already gone */
    }
  }
  try {
    window.localStorage.setItem(PANE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
  if (!on || !CTX) return
  try {
    if (typeof host.openWorkspace === 'function') {
      paneDisposer = host.openWorkspace('omniscience:live-pane', {
        title: 'Omniscience live',
        dock: { pane: 'workspace', pos: 'right' },
        render: () => jsx(LivePane, {}),
        onClose: () => {
          paneDisposer = null
          try { window.localStorage.setItem(PANE_KEY, '0') } catch { /* storage unavailable */ }
        },
      })
      return
    }
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
    ctx.onDispose?.(() => {
      roomAfterClosing = null
      roomCleanup?.()
      const dispose = paneDisposer
      paneDisposer = null
      if (dispose) dispose()
      CTX = null
    })
    ctx.registerSettingsPage?.({ id: 'preferences', title: 'Omniscience', render: () => jsx(RoomSettings, {}) })
    if (!ctx.registerSettingsPage) ctx.register({
      id: 'make-room-setting',
      area: 'palette',
      data: {
        id: 'omniscience.toggleMakeRoom',
        label: 'Omniscience: Turn automatic room on or off',
        run: () => setRoomWanted(ctx, !roomWanted(ctx)),
      },
    })
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
