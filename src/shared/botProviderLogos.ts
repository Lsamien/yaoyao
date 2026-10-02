import type { BotMcpPlugin } from './workspacePlugins.js'

/** Bundled logos keep the built-in directory usable without a third-party request. */
const providers: Record<string, { hosts: string[] }> = {
  gmail: { hosts: ['gmail.com'] },
  googledrive: { hosts: ['drive.google.com'] },
  googlecalendar: { hosts: ['calendar.google.com'] },
  github: { hosts: ['github.com', 'githubcopilot.com'] },
  notion: { hosts: ['notion.so', 'notion.com'] },
  slack: { hosts: ['slack.com'] },
  linear: { hosts: ['linear.app'] },
  discord: { hosts: ['discord.com'] },
  outlook: { hosts: ['outlook.com', 'outlook.office.com'] },
  trello: { hosts: ['trello.com'] },
  airtable: { hosts: ['airtable.com'] },
  twitter: { hosts: ['twitter.com', 'x.com'] },
}
const aliases: Record<string, string> = { gdrive: 'googledrive', x: 'twitter', microsoftoutlook: 'outlook' }

export const BOT_LOGO_ORIGINS = ['https://logos.composio.dev', 'https://assets.composio.dev'] as const

export function bundledProviderLogo(slug: string): string | undefined {
  const key = slug.toLowerCase().replace(/[\s_-]/g, '')
  const provider = aliases[key] ?? key
  return Object.hasOwn(providers, provider) ? `/provider-logos/${provider}.svg` : undefined
}

/** Match the image CSP; never forward credentials or arbitrary image origins. */
export function safeProviderLogo(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  if (Object.keys(providers).some(slug => value === bundledProviderLogo(slug))) return value
  try {
    const url = new URL(value)
    if (url.username || url.password || !BOT_LOGO_ORIGINS.some(origin => url.origin === origin)) return undefined
    return url.href
  } catch { return undefined }
}

export function mcpProviderLogo(plugin: BotMcpPlugin): string | undefined {
  if (plugin.transport === 'http' && plugin.url) {
    try {
      const host = new URL(plugin.url).hostname.toLowerCase()
      const provider = Object.entries(providers).find(([, { hosts }]) => hosts.some(domain => host === domain || host.endsWith(`.${domain}`)))
      if (provider) return bundledProviderLogo(provider[0])
    } catch { /* Older invalid definitions still get a readable placeholder. */ }
  }
  if (plugin.transport === 'stdio') {
    for (const arg of [plugin.command ?? '', ...(plugin.args ?? [])]) {
      const packageName = arg.toLowerCase().replace(/^--package=/, '').replace(/@[^/@]+$/, '')
      if (packageName === '@notionhq/notion-mcp-server') return bundledProviderLogo('notion')
      const slug = /^@modelcontextprotocol\/server-([a-z-]+)$/.exec(packageName)?.[1]
      const logo = slug && bundledProviderLogo(slug)
      if (logo) return logo
    }
  }
  return bundledProviderLogo(plugin.name.replace(/\s*(?:mcp(?:\s*(?:server|服务))?|server|服务)$/i, '').trim())
}
