'use strict'

const api = window.huddle

const el = {
  dot: document.getElementById('dot'),
  title: document.getElementById('title'),
  hide: document.getElementById('hide'),
  feed: document.getElementById('feed'),
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty'),
  link: document.getElementById('link'),
  action: document.getElementById('action'),
  tokenbar: document.getElementById('tokenbar'),
  token: document.getElementById('token'),
  savetoken: document.getElementById('savetoken'),
  status: document.getElementById('status'),
  count: document.getElementById('count'),
  settings: document.getElementById('settings'),
  settingspanel: document.getElementById('settingspanel'),
  grip: document.getElementById('grip')
}

const PALETTE = ['#4c8dff', '#e06c92', '#4fbe8f', '#d8a04a', '#9d7ce8', '#4bb4c9']

let settings = {}
let watching = false
let currentLabel = ''

const data = new Map() // id -> message object
const nodes = new Map() // id -> element refs
const timers = new Map() // id -> removal timeout

// ------------------------------------------------------------- helpers

function hueFor(id) {
  let h = 0
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) & 0xffff
  return PALETTE[h % PALETTE.length]
}

function initials(name) {
  return String(name || '?').trim().charAt(0).toUpperCase() || '?'
}

function timeOf(ms) {
  const d = new Date(ms || Date.now())
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function setStatus(text, error) {
  el.status.textContent = text
  el.status.classList.toggle('err', !!error)
  el.dot.className = 'dot' + (error ? ' err' : watching ? ' live' : '')
}

function updateCount() {
  el.count.textContent = String(nodes.size)
}

// ------------------------------------------------------------- messages

function addMessage(msg) {
  if (nodes.has(msg.id)) return
  data.set(msg.id, msg)

  const node = document.createElement('div')
  node.className = 'msg' + (msg.mine ? ' mine' : '')

  const avatar = document.createElement('div')
  avatar.className = 'avatar'

  const body = document.createElement('div')
  body.className = 'body'

  const meta = document.createElement('div')
  meta.className = 'meta'

  const name = document.createElement('span')
  name.className = 'name'

  const time = document.createElement('span')
  time.className = 'time'

  const text = document.createElement('div')
  text.className = 'text'

  meta.append(name, time)
  body.append(meta, text)
  node.append(avatar, body)
  el.messages.append(node)

  nodes.set(msg.id, { node, avatar, name, time, text })
  paint(msg.id)

  el.empty.hidden = true
  trim()
  el.feed.scrollTop = el.feed.scrollHeight
  updateCount()
  scheduleRemoval(msg.id)
}

function patchMessage(id, patch) {
  const msg = data.get(id)
  if (!msg) return
  Object.assign(msg, patch)
  paint(id)
}

function paint(id) {
  const msg = data.get(id)
  const refs = nodes.get(id)
  if (!msg || !refs) return

  refs.name.textContent = msg.userName || 'unknown'
  refs.text.textContent = msg.text || ''
  refs.time.textContent = timeOf(msg.ts)
  refs.time.hidden = !settings.showTimestamps

  if (msg.avatar) {
    let img = refs.avatar.querySelector('img')
    if (!img) {
      img = document.createElement('img')
      img.onerror = () => { img.remove() }
      refs.avatar.textContent = ''
      refs.avatar.append(img)
    }
    if (img.getAttribute('src') !== msg.avatar) img.setAttribute('src', msg.avatar)
  } else if (refs.avatar.querySelector('img')) {
    refs.avatar.textContent = initials(msg.userName)
  } else {
    refs.avatar.textContent = initials(msg.userName)
  }

  refs.avatar.style.background = hueFor(msg.userId || msg.id)
}

function scheduleRemoval(id) {
  const life = Number(settings.messageDuration || 0)
  const existing = timers.get(id)
  if (existing) clearTimeout(existing)
  if (!life) return
  timers.set(id, setTimeout(() => removeMessage(id), life * 1000))
}

function removeMessage(id) {
  const refs = nodes.get(id)
  if (!refs) return
  refs.node.classList.add('leaving')
  setTimeout(() => {
    refs.node.remove()
    nodes.delete(id)
    data.delete(id)
    timers.delete(id)
    if (nodes.size === 0) el.empty.hidden = false
    updateCount()
  }, 300)
}

function trim() {
  const max = Number(settings.maxMessages || 60)
  while (nodes.size > max) {
    const first = nodes.keys().next().value
    const refs = nodes.get(first)
    if (refs) refs.node.remove()
    nodes.delete(first)
    data.delete(first)
    if (timers.has(first)) clearTimeout(timers.get(first))
    timers.delete(first)
  }
}

function clearAll() {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  nodes.clear()
  data.clear()
  el.messages.innerHTML = ''
  el.empty.hidden = false
  updateCount()
}

// ------------------------------------------------------------- events

api.onMessage((msg) => {
  if (msg && msg.patch) {
    patchMessage(msg.id, msg.patch)
    return
  }
  addMessage(msg)
})

api.onStatus((s) => {
  watching = !!s.watching
  if (s.label) currentLabel = s.label
  else if (s.channel && !currentLabel) currentLabel = s.channel
  if (!watching) currentLabel = ''
  el.title.textContent = watching ? currentLabel || 'Watching' : 'Huddle Overlay'
  if (s.text) setStatus(s.text, s.error)
  renderAction()
})

api.onSettings((s) => {
  settings = Object.assign({}, settings, s)
  applySettings()
})

// ------------------------------------------------------------- actions

async function doWatch() {
  const link = el.link.value.trim()
  if (!link) return
  el.action.disabled = true
  const res = await api.watch(link)
  el.action.disabled = false

  if (!res || !res.ok) {
    setStatus((res && res.error) || 'Could not read that link', true)
    if (res && res.needToken) showTokenBar(true)
    return
  }
  el.link.value = ''
  clearAll()
}

function renderAction() {
  if (watching) {
    el.action.textContent = 'Stop'
    el.action.classList.remove('primary')
    el.link.hidden = true
  } else {
    el.action.textContent = 'Watch'
    el.action.classList.add('primary')
    el.link.hidden = false
  }
  const headline = document.querySelector('#empty .headline')
  const sub = document.querySelector('#empty .sub')
  if (headline && sub) {
    headline.textContent = watching ? 'Waiting for messages…' : 'No thread linked'
    sub.textContent = watching
      ? currentLabel || 'Listening for new messages'
      : 'Paste a Slack thread link below and press Watch.'
  }
}

el.action.addEventListener('click', () => {
  if (watching) api.stop()
  else doWatch()
})

el.link.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doWatch()
})

el.hide.addEventListener('click', () => api.hide())

el.settings.addEventListener('click', () => {
  el.settingspanel.hidden = !el.settingspanel.hidden
})

// ------------------------------------------------------------- token

function showTokenBar(show) {
  el.tokenbar.hidden = !show
  if (show) el.token.focus()
}

el.savetoken.addEventListener('click', async () => {
  const token = el.token.value.trim()
  if (!token) return
  el.savetoken.disabled = true
  const res = await api.setToken(token)
  el.savetoken.disabled = false
  if (res && res.ok) {
    el.token.value = ''
    showTokenBar(false)
    settings.hasToken = true
    setStatus('Connected to ' + (res.team || 'Slack'))
  } else {
    setStatus('Token rejected: ' + ((res && res.error) || 'unknown'), true)
  }
})

el.token.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.savetoken.click()
})

// ------------------------------------------------------------- settings

function bindRange(id, key, format) {
  const input = document.getElementById(id)
  const out = document.getElementById(id.replace('s-', 'o-'))
  input.addEventListener('input', () => {
    const value = Number(input.value)
    settings[key] = value
    if (out) out.textContent = format(value)
    api.setSettings({ [key]: value })
    applySettings()
  })
  return input
}

function bindToggle(id, key) {
  const input = document.getElementById(id)
  input.addEventListener('change', () => {
    settings[key] = input.checked
    api.setSettings({ [key]: input.checked })
    applySettings()
    if (key === 'showTimestamps') for (const id of data.keys()) paint(id)
  })
  return input
}

const sOpacity = bindRange('s-opacity', 'opacity', (v) => Math.round(v * 100) + '%')
const sFont = bindRange('s-font', 'fontSize', (v) => v + 'pt')
const sLife = bindRange('s-life', 'messageDuration', (v) => (v === 0 ? 'never' : v + 's'))
const sTime = bindToggle('s-time', 'showTimestamps')
const sClick = bindToggle('s-click', 'clickThrough')
const sCapture = bindToggle('s-capture', 'contentProtection')

document.getElementById('s-token').addEventListener('click', () => {
  showTokenBar(el.tokenbar.hidden)
})

function applySettings() {
  document.documentElement.style.setProperty('--font', Number(settings.fontSize || 13) + 'px')
  const alpha = Math.min(1, Math.max(0.25, Number(settings.opacity ?? 0.95)))
  document.documentElement.style.setProperty(
    '--bg',
    'rgba(17, 19, 24, ' + alpha.toFixed(3) + ')'
  )

  if (document.activeElement !== sOpacity) sOpacity.value = settings.opacity
  document.getElementById('o-opacity').textContent = Math.round(Number(settings.opacity ?? 0.92) * 100) + '%'

  if (document.activeElement !== sFont) sFont.value = settings.fontSize
  document.getElementById('o-font').textContent = Number(settings.fontSize || 13) + 'pt'

  if (document.activeElement !== sLife) sLife.value = settings.messageDuration
  const life = Number(settings.messageDuration ?? 30)
  document.getElementById('o-life').textContent = life === 0 ? 'never' : life + 's'

  sTime.checked = !!settings.showTimestamps
  sClick.checked = !!settings.clickThrough
  sCapture.checked = !!settings.contentProtection
}

// ------------------------------------------------------------- resize grip

let dragging = false
let lastX = 0
let lastY = 0

el.grip.addEventListener('pointerdown', (e) => {
  dragging = true
  lastX = e.screenX
  lastY = e.screenY
  try { el.grip.setPointerCapture(e.pointerId) } catch {}
  e.preventDefault()
})

el.grip.addEventListener('pointermove', (e) => {
  if (!dragging) return
  const dx = e.screenX - lastX
  const dy = e.screenY - lastY
  if (!dx && !dy) return
  lastX = e.screenX
  lastY = e.screenY
  api.resize(dx, dy)
})

el.grip.addEventListener('pointerup', (e) => {
  dragging = false
  try { el.grip.releasePointerCapture(e.pointerId) } catch {}
})

// ------------------------------------------------------------- boot

;(async function boot() {
  settings = (await api.getSettings()) || {}
  if (settings.messageDuration === undefined) settings.messageDuration = 30
  applySettings()
  renderAction()

  if (!settings.hasToken) {
    showTokenBar(true)
    setStatus('Paste your Slack token to start')
  } else {
    setStatus('Ready')
  }
})()
