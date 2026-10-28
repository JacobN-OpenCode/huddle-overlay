'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

function dir() {
  return app.getPath('userData')
}

function settingsPath() {
  return path.join(dir(), 'settings.json')
}

function logPath() {
  return path.join(dir(), 'huddle-overlay.log')
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function write(data) {
  try {
    fs.mkdirSync(dir(), { recursive: true })
    const tmp = settingsPath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, settingsPath())
  } catch (err) {
    log('could not save settings: ' + err.message)
  }
}

function log(message) {
  try {
    fs.mkdirSync(dir(), { recursive: true })
    const line = `[${new Date().toISOString()}] ${message}\n`
    const file = logPath()
    try {
      const stat = fs.statSync(file)
      if (stat.size > 512 * 1024) fs.truncateSync(file, 0)
    } catch {}
    fs.appendFileSync(file, line)
  } catch {}
}

module.exports = { read, write, log, logPath, dir, settingsPath }
