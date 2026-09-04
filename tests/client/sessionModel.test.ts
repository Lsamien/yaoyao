import { describe, expect, it } from 'vitest'
import { modelForChoiceId, modelForSession, modelSelectionFromSessionInfo } from '@/utils/sessionModel'
import { normalizeSession } from '@/utils/normalize'
import { isOwnedChatSession } from '@/utils/sessionOwnership'

const models = [
  { id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra', provider: 'custom' },
  { id: 'glm-5.3', name: 'GLM 5.3', provider: 'custom', isDefault: true },
]

describe('session model selection', () => {
  it('restores the saved model case-insensitively instead of the profile default', () => {
    expect(modelForSession(models, 'GPT-5.6-terra', 'CUSTOM')).toEqual(models[0])
  })

  it('keeps an unavailable stored model visible until the user chooses another', () => {
    expect(modelForSession(models, 'archived-model', 'legacy')).toEqual({ id: 'archived-model', name: 'archived-model', provider: 'legacy' })
  })

  it('reads model changes from both session.info payload shapes', () => {
    expect(modelSelectionFromSessionInfo({ model: 'gpt-5.6-sol', provider: 'openai-codex' })).toEqual({
      model: 'gpt-5.6-sol', provider: 'openai-codex',
    })
    expect(modelSelectionFromSessionInfo({ info: { model: 'MiniMax-M3', provider: 'minimax' } })).toEqual({
      model: 'MiniMax-M3', provider: 'minimax',
    })
    expect(modelSelectionFromSessionInfo({ info: { provider: 'minimax' } })).toBeUndefined()
  })

  it('restores the provider from Hermes model_config session details', () => {
    expect(normalizeSession({
      id: 'session-1', model: 'omni',
      model_config: JSON.stringify({ model: 'omni', provider: 'custom:tingly' }),
    })).toMatchObject({ model: 'omni', provider: 'custom:tingly' })
  })

  it('uses server ownership rather than source to separate chats from history', () => {
    const ownedIOS = normalizeSession({
      id: 'owned-ios', source: 'ios', owned: true, title: '跨端聊天',
    })
    const unownedWeb = normalizeSession({
      id: 'native-web', source: 'web', owned: false, title: '原生历史',
    })

    expect(isOwnedChatSession(ownedIOS)).toBe(true)
    expect(isOwnedChatSession(unownedWeb)).toBe(false)
    expect(isOwnedChatSession({ id: 'draft-local', owned: undefined })).toBe(true)
    expect(isOwnedChatSession({ id: 'draft-server-history', owned: false })).toBe(false)
  })

  it('finds a chosen model when its provider contains a colon', () => {
    const tinglyModel = { id: 'omni', name: 'Omni', provider: 'Custom:Tingly' }
    expect(modelForChoiceId([tinglyModel], 'Custom:Tingly:omni')).toEqual(tinglyModel)
  })
})
