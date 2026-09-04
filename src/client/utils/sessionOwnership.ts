import type { SessionSummary } from '@shared/types'

/**
 * The 15300 registry owns chat membership. A local Web draft is the only
 * pre-registration row allowed on the chat surface.
 */
export function isOwnedChatSession(session: Pick<SessionSummary, 'id' | 'owned'>): boolean {
  return session.owned === true
    || (session.owned === undefined && session.id.startsWith('draft-'))
}
