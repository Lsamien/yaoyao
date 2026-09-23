// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopActivation } from '../../src/server/desktopActivation'
import { deferDesktopActivation, desktopActivationPath } from '../../bin/lib/desktop-activation.mjs'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'yaoyao-runtime-activation-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('desktop environment preparation', () => {
  it('keeps Hermes stopped until entering local mode and starts it once', () => {
    const launch = vi.fn(), activation = new DesktopActivation(home, true, launch)
    activation.start(); activation.start()
    expect(activation.required).toBe(true)
    expect(launch).not.toHaveBeenCalled()
    expect(existsSync(desktopActivationPath(home))).toBe(false)
    activation.activate(); activation.activate(); activation.start()
    expect(activation.required).toBe(false)
    expect(launch).toHaveBeenCalledTimes(1)
    if (process.platform !== 'win32') expect(statSync(desktopActivationPath(home)).mode & 0o777).toBe(0o600)
  })
  it('resumes an authorized independent background process after restart', () => {
    const launch = vi.fn(), previous = new DesktopActivation(home, true, launch)
    previous.activate()
    const replacement = new DesktopActivation(home, true, launch)
    replacement.start()
    expect(replacement.required).toBe(false)
    expect(launch).toHaveBeenCalledTimes(2)
  })
  it('requires a fresh entry when a later environment check starts the service', () => {
    const launch = vi.fn(), previous = new DesktopActivation(home, true, launch)
    previous.activate()
    deferDesktopActivation(home)
    const replacement = new DesktopActivation(home, true, launch)
    replacement.start()
    expect(replacement.required).toBe(true)
    expect(launch).toHaveBeenCalledTimes(1)
    replacement.activate()
    expect(launch).toHaveBeenCalledTimes(2)
  })
  it('preserves explicitly configured independent service supervision', () => {
    const launch = vi.fn(), activation = new DesktopActivation(home, false, launch)
    activation.start(); activation.activate()
    expect(activation.required).toBe(false)
    expect(launch).toHaveBeenCalledTimes(1)
  })
  it('does not trust a malformed or unsupported saved activation', () => {
    for (const value of ['broken', '{}', '{"version":2}']) {
      writeFileSync(desktopActivationPath(home), value)
      const launch = vi.fn(), activation = new DesktopActivation(home, true, launch)
      activation.start()
      expect(activation.required).toBe(true)
      expect(launch).not.toHaveBeenCalled()
    }
  })
})
