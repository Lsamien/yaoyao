import type { ModelOption, Profile } from '@shared/types'
import { apiRequest, unwrapData } from './client'
import { normalizeModel, normalizeProfile, record, values } from '@/utils/normalize'
import type { AgentAvatarMode, AgentMascotExpression, AgentMascotShape } from '@shared/agentIdentity'

export type ProfileIdentityInput = {
  title: string
  avatarMode: AgentAvatarMode
  shape: AgentMascotShape
  color: string
  expression: AgentMascotExpression
  bodyId?: import("@shared/agentIdentity").AgentMascotBody | null
  imageCrop?: import("@shared/agentIdentity").AgentImageCrop
  avatarDataURL?: string | null
}

/** Yaoyao-owned display identity of every base Profile (read through the in-process Hermes). */
export async function getProfileIdentities(profiles: Profile[]): Promise<Record<string, { displayName: string; avatar: string }>> {
  if (!profiles.length) return {}
  const allowed = new Set(profiles.map(profile => profile.name))
  const payload = record(await apiRequest<unknown>('/api/profile-identities'))
  return Object.fromEntries(values(payload.profiles).flatMap(raw => {
    const item = record(raw)
    const name = typeof item.name === 'string' ? item.name : ''
    if (!allowed.has(name)) return []
    return [[name, { displayName: String(item.displayName ?? name), avatar: String(item.avatar ?? '') }]]
  }))
}

export async function getProfiles(): Promise<Profile[]> {
  const payload = unwrapData(await apiRequest<unknown>('/api/app/profiles'))
  const source = record(payload)
  return values(source.profiles ?? source.items ?? payload).map(normalizeProfile)
}

export async function getModels(profile?: string): Promise<ModelOption[]> {
  const suffix = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const payload = unwrapData(await apiRequest<unknown>(`/api/app/models${suffix}`))
  const source = record(payload)
  if (Array.isArray(source.providers)) {
    const currentModel = typeof source.model === 'string' ? source.model : ''
    const currentProvider = typeof source.provider === 'string' ? source.provider : ''
    return source.providers.flatMap(rawProvider => {
      const provider = record(rawProvider)
      const slug = typeof provider.slug === 'string' ? provider.slug : typeof provider.name === 'string' ? provider.name : ''
      const capabilities = record(provider.capabilities)
      return values(provider.models).flatMap(rawModel => {
        const model = typeof rawModel === 'string' ? rawModel : String(record(rawModel).id ?? record(rawModel).model ?? '')
        if (!model || !slug) return []
        const modelCapabilities = record(capabilities[model])
        return [{
          id: model,
          name: model,
          provider: slug,
          supportsReasoning: typeof modelCapabilities.reasoning === 'boolean' ? modelCapabilities.reasoning : undefined,
          isDefault: model === currentModel && slug === currentProvider,
        } satisfies ModelOption]
      })
    })
  }
  return values(source.models ?? source.items ?? payload).map(normalizeModel).filter(model => model.id)
}
