export interface BotMcpPlugin {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  envKeys: string[]
  headerKeys: string[]
  enabled: boolean
  agentIds: string[]
  revision: number
  testedAt?: number
  toolCount: number
}
export interface BotAppCard { slug: string; name: string; description: string }
export interface BotAppAccount { id: string; alias?: string; status: string }
export interface BotAppConnection { slug: string; accounts: BotAppAccount[]; agentIds: string[]; revision: number }
export interface BotPluginSettings { configured: boolean; revision: number }
