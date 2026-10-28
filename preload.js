'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('huddle', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setToken: (token) => ipcRenderer.invoke('token:set', token),
  watch: (link) => ipcRenderer.invoke('watch', link),
  stop: () => ipcRenderer.invoke('stop'),
  hide: () => ipcRenderer.invoke('hide'),
  resize: (dx, dy) => ipcRenderer.invoke('resize', { dx, dy }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onMessage: (cb) => ipcRenderer.on('message', (_e, m) => cb(m)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s))
})
