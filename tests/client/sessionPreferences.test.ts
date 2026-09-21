import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  moveSessionFastMode, readAgentShowThinking, readSessionFastMode, writeAgentShowThinking, writeSessionFastMode,
} from '@/utils/sessionPreferences'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('session and Agent display preferences', () => {
  it('isolates fast mode by account, Agent, and session', () => {
    writeSessionFastMode('u1', 'yaoer', 's1', true)
    expect(readSessionFastMode('u1', 'yaoer', 's1')).toBe(true)
    expect(readSessionFastMode('u1', 'default', 's1')).toBe(false)
    expect(readSessionFastMode('u2', 'yaoer', 's1')).toBe(false)
    expect(readSessionFastMode('u1', 'yaoer', 's2')).toBe(false)
  })

  it('moves a draft fast-mode selection to the stored session identity', () => {
    writeSessionFastMode('u1', 'default', 'draft-1', true)
    moveSessionFastMode('u1', 'default', 'draft-1', 'stored-1', true)
    expect(readSessionFastMode('u1', 'default', 'draft-1')).toBe(false)
    expect(readSessionFastMode('u1', 'default', 'stored-1')).toBe(true)
  })

  it('hides thinking by default and stores an explicit choice per account and Agent', () => {
    expect(readAgentShowThinking('u1', 'yaoer')).toBe(false)
    writeAgentShowThinking('u1', 'yaoer', false)
    expect(readAgentShowThinking('u1', 'yaoer')).toBe(false)
    expect(readAgentShowThinking('u1', 'default')).toBe(false)
    writeAgentShowThinking('u1', 'yaoer', true)
    expect(readAgentShowThinking('u1', 'yaoer')).toBe(true)
  })
})
