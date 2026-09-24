import type { BotBrowserState } from './desktopEnvironment.js'

export type ComputerBackend = 'desktop' | 'cloud' | 'vm' | 'managed-browser'

export interface BrowserInstallation {
  status: 'checking' | 'missing' | 'installing' | 'ready' | 'failed'
  message: string
  progress?: number
  error?: string
  updatedAt: number
}

/** Created by the server for a real browser tool session, never parsed from model text. */
export interface ManagedBrowserCard {
  id: string
  agentId: string
  agentName: string
  status: 'preparing' | 'ready' | 'active' | 'idle' | 'closed' | 'failed'
  title?: string
  url?: string
  message?: string
  installation?: BrowserInstallation
  updatedAt: number
}

/** Read-only browser facts; fetching this state never opens a browser. */
export interface ManagedBrowserState extends BotBrowserState {
  enabled: boolean
  available: boolean
  supportsRetention?: boolean
  reason?: string
  installation?: BrowserInstallation
  generation: number
  downloads: { id: string; name: string; size: number }[]
}
