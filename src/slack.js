'use strict'

const store = require('./store')

const API = 'https://slack.com/api/'
const POLL_MS = 2000
const FIRST_FETCH_BACKLOG = 12

let timer = null
let current = null // { channel, ts }
let oldest = null
let seen = new Set()
let myUserId = ''
let inFlight = false

let messageHandler = () => {}
let statusHandler = () => {}

let userCache = null

function cache() {
  if (!userCache) {
    const saved = store.read().userCache
    userCache = saved && typeof saved === 'object' ? saved : {}
  }
  return userCache
}

function persistCache() {
  if (!userCache) return
  const all = store.read()
  all.userCache = userCache
  store.write(all)
}

function onMessage(fn) { messageHandler = fn }
function onStatus(fn) { statusHandler = fn }

function status(text, error = false, extra = {}) {
  statusHandler(Object.assign({ text, error }, extra))
}

// ------------------------------------------------------------------ parsing

/**
 * Accepts:
 *   https://team.slack.com/archives/C123/p1698765432123456
 *   https://team.slack.com/archives/C123/p1698...?thread_ts=1698765432.123456
 *   https://app.slack.com/client/T123/C123/thread/C123-1698765432.123456
 *   C123|1698765432.123456        C123 1698765432.123456
 *   1698765432.123456             (reuses the last channel)
 *   C123                          (whole channel)
 */
function parseLink(raw) {
  const text = String(raw || '').trim()
  if (!text) return null

  const grab = (re) => {
    const m = text.match(re)
    return m ? m[1] : null
  }

  let channel =
    grab(/\/archives\/([CGD][A-Z0-9]{6,})/i) ||
    grab(/\/client\/[A-Z0-9]+\/([CGD][A-Z0-9]{6,})/i) ||
    grab(/\/thread\/([CGD][A-Z0-9]{6,})-/i) ||
    grab(/^([CGD][A-Z0-9]{6,})/i) ||
    grab(/([CGD][A-Z0-9]{6,})/i)

  let ts =
    grab(/thread_ts=([0-9]{10}\.[0-9]{6})/) ||
    null

  if (!ts) {
    const p = grab(/\/p([0-9]{16})/)
    if (p) ts = p.slice(0, 10) + '.' + p.slice(10)
  }
  if (!ts) ts = grab(/([0-9]{10}\.[0-9]{6})/)

  const threadTs = grab(/\/thread\/[A-Z0-9]+-([0-9]{10}\.[0-9]{6})/i)
  if (threadTs) ts = threadTs

  if (!channel) {
    if (current && current.channel) channel = current.channel
    else if (lastWatchChannel()) channel = lastWatchChannel()
  }

  if (!channel) return null
  return { channel: channel.toUpperCase(), ts }
}

function lastWatchChannel() {
  const s = store.read()
  const raw = s.lastWatch || ''
  const channel = raw.split('|')[0]
  return channel || null
}

// ------------------------------------------------------------------ transport

async function call(method, params, token) {
  const body = new URLSearchParams(params)
  const res = await fetch(API + method, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  })
  if (res.status === 429) return { ok: false, error: 'ratelimited' }
  return res.json()
}

function verify(settings) {
  if (!settings.token) return Promise.resolve({ ok: false, error: 'no token' })
  return call('auth.test', {}, settings.token)
    .then((json) => {
      if (!json || !json.ok) {
        store.log('auth failed: ' + ((json && json.error) || 'network'))
        return { ok: false, error: (json && json.error) || 'network error' }
      }
      myUserId = json.user_id || ''
      store.log(`auth ok team=${json.team} user=${json.user}`)
      return { ok: true, team: json.team || json.url || 'Slack' }
    })
    .catch((err) => {
      store.log('auth threw: ' + err.message)
      return { ok: false, error: err.message }
    })
}

// ------------------------------------------------------------------ watching

async function start(settings, key) {
  stop()
  current = key
  seen = new Set()
  oldest = null

  store.log(`watch start channel=${key.channel} ts=${key.ts || '-'}`)
  status('Loading…', false, { watching: true, channel: key.channel })

  resolveChannelName(settings, key.channel)
  await fetchNew(settings, true)

  timer = setInterval(() => fetchNew(settings, false), POLL_MS)
  return { ok: true }
}

function resume(settings) {
  const raw = settings.lastWatch || ''
  const parts = raw.split('|')
  if (!parts[0]) return
  const key = { channel: parts[0], ts: parts[1] || null }
  start(settings, key)
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
  current = null
  oldest = null
  seen = new Set()
  status('Stopped', false, { watching: false })
}

async function resolveChannelName(settings, channel) {
  try {
    const json = await call('conversations.info', { channel }, settings.token)
    if (json && json.ok && json.channel) {
      const name = json.channel.name || channel
      const isPrivate = !!json.channel.is_private
      status('Live', false, {
        watching: true,
        channel,
        label: (isPrivate ? '#' : '#') + name + (isPrivate ? ' (private)' : '')
      })
    }
  } catch {}
}

async function fetchNew(settings, isFirst) {
  if (!current || inFlight) return
  inFlight = true

  const key = current
  const params = { channel: key.channel, limit: '40' }
  if (oldest) params.oldest = oldest
  const method = key.ts ? 'conversations.replies' : 'conversations.history'
  if (key.ts) params.ts = key.ts

  let json
  try {
    json = await call(method, params, settings.token)
  } catch (err) {
    inFlight = false
    status('Network error', true)
    return
  }
  inFlight = false

  if (!json || !json.ok) {
    const err = (json && json.error) || 'network error'
    const friendly = {
      not_in_channel: "You're not in that channel",
      channel_not_found: 'Channel not found',
      thread_not_found: 'Thread not found',
      missing_scope: 'Token is missing a scope',
      invalid_auth: 'Token is invalid. Paste a new one.',
      not_authed: 'Token is invalid. Paste a new one.',
      token_revoked: 'Token was revoked. Paste a new one.',
      ratelimited: 'Rate limited, retrying…'
    }[err] || err
    store.log(`fetch error: ${err} (${method} ${key.channel})`)
    if (err !== 'ratelimited') status(friendly, true, { watching: true })
    return
  }

  let messages = (json.messages || []).slice().sort((a, b) => Number(a.ts) - Number(b.ts))
  const firstLoad = oldest === null
  if (firstLoad && messages.length > FIRST_FETCH_BACKLOG) {
    messages = messages.slice(-FIRST_FETCH_BACKLOG)
  }

  let added = 0
  for (const m of messages) {
    const ts = m.ts
    if (!ts) continue
    if (oldest && Number(ts) <= Number(oldest)) continue
    if (seen.has(ts)) continue
    seen.add(ts)
    oldest = ts

    if (m.subtype === 'message_deleted') continue

    const text = cleanText(m.text || '')
    if (!text) continue

    const userId = m.user || m.bot_id || 'unknown'
    const fallback =
      m.username ||
      (m.bot_profile && m.bot_profile.name) ||
      (userId || 'unknown')

    messageHandler({
      id: ts,
      userId,
      userName: fallback,
      avatar: null,
      text,
      ts: Number(ts) * 1000,
      mine: userId === myUserId
    })
    added++
    resolveUser(settings, userId, ts)
  }

  if (added > 0) {
    store.log(`received ${added} new message(s) in ${key.channel}`)
  }
  status('Live', false, { watching: true })
}

async function resolveUser(settings, userId, messageTs) {
  if (!/^[UW]/.test(userId)) return
  const c = cache()
  if (c[userId]) {
    messageHandler({ id: messageTs, patch: { userName: c[userId].name, avatar: c[userId].avatar } })
    return
  }
  try {
    const json = await call('users.info', { user: userId }, settings.token)
    if (!json || !json.ok || !json.user) return
    const u = json.user
    const p = u.profile || {}
    const name = p.display_name || u.real_name || u.name || userId
    const avatar = p.image_48 || p.image_72 || null
    c[userId] = { name, avatar }
    persistCache()
    messageHandler({ id: messageTs, patch: { userName: name, avatar } })
  } catch {}
}

// ------------------------------------------------------------------ helpers

const REPLACEMENTS = [
  [/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2'],
  [/<(https?:\/\/[^>]+)>/g, '$1'],
  [/<#[A-Z0-9]+\|([^>]+)>/g, '#$1'],
  [/<#([A-Z0-9]+)>/g, '#$1'],
  [/<@[A-Z0-9]+\|([^>]+)>/g, '@$1'],
  [/<@([A-Z0-9]+)>/g, '@$1']
]

function cleanText(input) {
  let s = String(input || '')
  for (const [re, to] of REPLACEMENTS) s = s.replace(re, to)
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

module.exports = { parseLink, verify, start, resume, stop, onMessage, onStatus, cleanText }
