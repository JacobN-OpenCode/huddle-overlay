'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, globalShortcut, shell, screen } = require('electron')
const path = require('path')
const store = require('./src/store')
const slack = require('./src/slack')

const isMac = process.platform === 'darwin'

let win = null
let tray = null
let quitting = false

const DEFAULTS = {
  bounds: null,
  opacity: 0.95,
  fontSize: 13,
  messageDuration: 30,
  showTimestamps: true,
  clickThrough: false,
  contentProtection: false,
  maxMessages: 60,
  token: '',
  lastWatch: '',
  userCache: {}
}

let settings = Object.assign({}, DEFAULTS, store.read())

function save() {
  store.write(settings)
}

// ---------------------------------------------------------------- window

function createWindow() {
  // Place on the display the pointer is on — that's where people actually are.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = 380
  const height = 460
  const saved = settings.bounds && isValidBounds(settings.bounds) ? settings.bounds : null

  win = new BrowserWindow({
    width: saved ? saved.width : width,
    height: saved ? saved.height : height,
    x: saved ? saved.x : Math.round(display.x + display.width - width - 24),
    y: saved ? saved.y : Math.round(display.y + 24),
    minWidth: 260,
    minHeight: 180,
    maxWidth: 900,
    maxHeight: 1200,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    show: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setAlwaysOnTop(true, isMac ? 'screen-saver' : 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (isMac) win.setWindowButtonVisibility(false)

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  win.once('ready-to-show', () => {
    win.showInactive()
    applyAll()
    if (settings.lastWatch) slack.resume(settings)
  })

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
      buildTrayMenu()
    }
  })

  win.on('moved', rememberBounds)
  win.on('resized', rememberBounds)
}

function isValidBounds(b) {
  if (!b || typeof b.width !== 'number') return false
  if (b.width < 200 || b.height < 100) return false
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
  })
}

function rememberBounds() {
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  settings.bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
  save()
}

function applyAll() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('settings', publicSettings())
  applyClickThrough(settings.clickThrough)
  win.setContentProtection(!!settings.contentProtection)
  // Opacity is applied inside the page (panel backing only) so text stays crisp.
}

function applyClickThrough(on) {
  if (!win || win.isDestroyed()) return
  // forward:true keeps hover/scroll working for the underlying app.
  win.setIgnoreMouseEvents(!!on, { forward: true })
}

function publicSettings() {
  return {
    opacity: settings.opacity,
    fontSize: settings.fontSize,
    messageDuration: settings.messageDuration,
    showTimestamps: settings.showTimestamps,
    clickThrough: settings.clickThrough,
    contentProtection: settings.contentProtection,
    maxMessages: settings.maxMessages,
    hasToken: !!settings.token,
    lastWatch: settings.lastWatch
  }
}

function clamp(n, lo, hi) {
  n = Number(n)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

// ---------------------------------------------------------------- tray

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'build', isMac ? 'trayTemplate.png' : 'tray.png'))
  if (isMac) {
    icon.setTemplateImage(true)
    icon = icon.resize({ width: 18, height: 18 })
  } else {
    icon = icon.resize({ width: 16, height: 16 })
  }
  tray = new Tray(icon)
  tray.setToolTip('Huddle Overlay')
  tray.on('click', toggleWindow)
  buildTrayMenu()
}

function buildTrayMenu() {
  if (!tray) return
  const visible = !!win && win.isVisible()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? 'Hide overlay' : 'Show overlay', click: toggleWindow },
      { type: 'separator' },
      {
        label: 'Click-through',
        type: 'checkbox',
        checked: settings.clickThrough,
        accelerator: 'CommandOrControl+Alt+H',
        click: (item) => update({ clickThrough: item.checked })
      },
      {
        label: 'Hide from screen share',
        type: 'checkbox',
        checked: settings.contentProtection,
        click: (item) => update({ contentProtection: item.checked })
      },
      {
        label: 'Show timestamps',
        type: 'checkbox',
        checked: settings.showTimestamps,
        click: (item) => update({ showTimestamps: item.checked })
      },
      { type: 'separator' },
      { label: 'Unlink thread', click: () => slack.stop() },
      { label: 'Open log', click: () => shell.openPath(store.logPath()) },
      { type: 'separator' },
      { label: 'Quit Huddle Overlay', click: () => { quitting = true; app.quit() } }
    ])
  )
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible()) {
    win.hide()
  } else {
    win.showInactive()
  }
  buildTrayMenu()
}

function update(patch) {
  settings = Object.assign({}, settings, patch)
  save()
  applyAll()
  buildTrayMenu()
}

// ---------------------------------------------------------------- ipc

ipcMain.handle('settings:get', () => publicSettings())

ipcMain.handle('settings:set', (_e, patch) => {
  const clean = {}
  if ('opacity' in patch) clean.opacity = clamp(patch.opacity, 0.2, 1)
  if ('fontSize' in patch) clean.fontSize = clamp(patch.fontSize, 9, 22)
  if ('messageDuration' in patch) clean.messageDuration = clamp(patch.messageDuration, 0, 300)
  if ('maxMessages' in patch) clean.maxMessages = clamp(patch.maxMessages, 5, 500)
  if ('showTimestamps' in patch) clean.showTimestamps = !!patch.showTimestamps
  if ('clickThrough' in patch) clean.clickThrough = !!patch.clickThrough
  if ('contentProtection' in patch) clean.contentProtection = !!patch.contentProtection
  update(clean)
  return publicSettings()
})

ipcMain.handle('token:set', (_e, token) => {
  settings.token = String(token || '').trim()
  save()
  return slack.verify(settings).then((r) => {
    if (r.ok) {
      settings.workspace = r.team
      save()
    }
    return r
  })
})

ipcMain.handle('watch', async (_e, link) => {
  const key = slack.parseLink(link)
  if (!key) return { ok: false, error: "That doesn't look like a Slack thread link." }
  if (!settings.token) return { ok: false, error: 'Add your Slack token first.', needToken: true }
  settings.lastWatch = key.channel + '|' + (key.ts || '')
  save()
  const res = await slack.start(settings, key)
  return res
})

ipcMain.handle('stop', () => { slack.stop(); return true })

ipcMain.handle('hide', () => { if (win) win.hide(); buildTrayMenu(); return true })

ipcMain.handle('resize', (_e, { dx, dy }) => {
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  const width = clamp(b.width + dx, 260, 900)
  const height = clamp(b.height + dy, 180, 1200)
  win.setBounds({ x: b.x, y: b.y, width, height })
})

ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
})

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { win.showInactive(); win.focus() } })

  app.whenReady().then(() => {
    if (isMac && app.dock) app.dock.hide()
    createWindow()
    createTray()

    slack.onMessage((msg) => {
      if (win && !win.isDestroyed()) win.webContents.send('message', msg)
    })
    slack.onStatus((status) => {
      if (win && !win.isDestroyed()) win.webContents.send('status', status)
    })

    globalShortcut.register('CommandOrControl+Alt+H', () => update({ clickThrough: !settings.clickThrough }))

    app.on('activate', () => { if (win) win.showInactive() })
  })

  app.on('before-quit', () => {
    quitting = true
    globalShortcut.unregisterAll()
  })

  app.on('window-all-closed', (e) => {
    // Tray app: keep running.
    e.preventDefault && e.preventDefault()
  })
}
