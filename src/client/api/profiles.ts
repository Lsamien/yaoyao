import type { JsonValue, ModelOption, Profile } from '@shared/types'
import { apiRequest, unwrapData } from './client'
import { normalizeModel, normalizeProfile, record, values } from '@/utils/normalize'
import { ChatRpcSocket } from './realtime'
import {
  AGENT_MASCOT_EXPRESSIONS,
  AGENT_MASCOT_SHAPES,
  AGENT_MASCOT_BODIES, AGENT_IMAGE_CROPS,
  YAOYAO_AGENT_IDENTITY_NAMESPACE,
  agentIdentityFromProfile,
  agentIdentityMetadata,
  encodeAgentAvatar,
  type AgentAvatarMode,
  type AgentMascotExpression,
  type AgentMascotShape,
} from '@shared/agentIdentity'

const MAX_AGENT_NAME_LENGTH = 100
const MAX_AGENT_AVATAR_LENGTH = 2_800_000
const avatarDataURLPattern = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i

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

function jsonObject(value: unknown): Record<string, JsonValue> {
  return record(value) as Record<string, JsonValue>
}

function readProfileEntries(value: JsonValue): Record<string, JsonValue>[] {
  const source = jsonObject(value)
  return values(source.profiles).flatMap(item => {
    const outer = jsonObject(item)
    const profile = jsonObject(outer.profile)
    return Object.keys(profile).length ? [profile] : [outer]
  })
}

function validateIdentity(input: ProfileIdentityInput): ProfileIdentityInput {
  const title = input.title.trim().replace(/\s+/g, ' ')
  if (!title || title.length > MAX_AGENT_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error(`机器人名称应为 1 至 ${MAX_AGENT_NAME_LENGTH} 个字符`)
  }
  const avatarDataURL = input.avatarDataURL === undefined ? undefined : input.avatarDataURL?.trim() || null
  if (avatarDataURL && (avatarDataURL.length > MAX_AGENT_AVATAR_LENGTH || !avatarDataURLPattern.test(avatarDataURL))) {
    throw new Error('头像必须是小于 2 MB 的 PNG、JPEG 或 WebP 图片')
  }
  if (!AGENT_MASCOT_SHAPES.includes(input.shape)) throw new Error('请选择有效的头像形状')
  if (!AGENT_MASCOT_EXPRESSIONS.includes(input.expression)) throw new Error('请选择有效的基础表情')
  if (input.bodyId != null && !AGENT_MASCOT_BODIES.includes(input.bodyId)) throw new Error('请选择有效的造型')
  if (input.imageCrop != null && !AGENT_IMAGE_CROPS.includes(input.imageCrop)) throw new Error('请选择有效的裁剪')
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error('请选择有效的头像颜色')
  return {
    title,
    avatarMode: input.avatarMode === 'image' && avatarDataURL ? 'image' : 'mascot',
    shape: input.shape,
    color: input.color.toLowerCase(),
    expression: input.expression,
    bodyId: input.bodyId ?? null, imageCrop: input.imageCrop ?? 'rounded',
    avatarDataURL,
  }
}

/**
 * Yaoyao owns this identity in a dedicated Hermes metadata namespace. The
 * native Desktop Bots title/avatar are deliberately left untouched.
 */
export async function updateProfileIdentity(profile: Profile, input: ProfileIdentityInput): Promise<void> {
  const identity = validateIdentity(input)
  const control = new ChatRpcSocket()
  await control.connect()
  try {
    const listed = await control.request('profiles.list', { include_sessions: false })
    const current = readProfileEntries(listed).find(item => String(item.name ?? '') === profile.name)
    if (!current) throw new Error('该机器人已不存在，请刷新后重试')
    const revisions = jsonObject(current.ui_meta_revisions)
    const revision = typeof revisions[YAOYAO_AGENT_IDENTITY_NAMESPACE] === 'number'
      ? revisions[YAOYAO_AGENT_IDENTITY_NAMESPACE] as number
      : 0
    const currentIdentity = agentIdentityFromProfile(current)
    const nextIdentity = {
      ...currentIdentity,
      displayName: identity.title,
      avatarMode: identity.avatarMode,
      shape: identity.shape,
      color: identity.color,
      expression: identity.expression,
      bodyId: identity.bodyId ?? null,
      imageCrop: identity.imageCrop ?? 'rounded',
      ...(identity.avatarDataURL ? { imageDataURL: identity.avatarDataURL } : {}),
    }
    if (!identity.avatarDataURL) delete nextIdentity.imageDataURL
    await control.request('profiles.configure', {
      name: profile.name,
      ui_meta: {
        [YAOYAO_AGENT_IDENTITY_NAMESPACE]: agentIdentityMetadata(nextIdentity) as Record<string, JsonValue>,
      },
      ui_meta_expected_revisions: {
        [YAOYAO_AGENT_IDENTITY_NAMESPACE]: revision,
      },
    })
  } finally {
    control.close()
  }
}

/** Fetch Yaoyao-owned identity for every profile. */
export async function getProfileIdentities(profiles: Profile[]): Promise<Record<string, { displayName: string; avatar: string }>> {
  if (!profiles.length) return {}
  const allowed = new Set(profiles.map(profile => profile.name))
  const control = new ChatRpcSocket()
  await control.connect()
  try {
    const listed = await control.request('profiles.list', { include_sessions: false })
    return Object.fromEntries(
      readProfileEntries(listed)
        .filter(item => allowed.has(String(item.name ?? '')))
        .map(item => {
          const identity = agentIdentityFromProfile(item)
          return [String(item.name), {
            displayName: identity.displayName,
            avatar: encodeAgentAvatar(identity),
          }]
        }),
    )
  } finally {
    control.close()
  }
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
