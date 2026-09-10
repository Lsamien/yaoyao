import type { WorkspaceAgent as Agent } from '../shared/workspace.js'

export function mentionableText(text: string): string {
  return text
    .replace(/<quoted_message\b[^>]*>[\s\S]*?<\/quoted_message>/gi, '')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}.-]{1,255}\.[\p{L}]{2,63}/gu, '')
    .split('\n').filter(line => !line.trimStart().startsWith('>')).join('\n')
}

export function mentionedAgents(text: string, agents: Array<Pick<Agent, 'id' | 'name'>>): string[] {
  if (!text.includes('@')) return []
  const plain = mentionableText(text)
  const names = [...agents].sort((a, b) => b.name.length - a.name.length)
  const alternatives = [...names.map(a => a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'all', '所有人']
  const pattern = new RegExp(`(?<![A-Za-z0-9_.%+/@-])@(${alternatives.join('|')})(?![A-Za-z0-9_])`, 'giu')
  const result = new Set<string>()
  for (const match of plain.matchAll(pattern)) {
    const name = match[1]!
    if (/^(all|所有人)$/i.test(name)) { for (const a of agents) result.add(a.id) }
    else { const a = agents.find(a => a.name.toLocaleLowerCase() === name.toLocaleLowerCase()); if (a) result.add(a.id) }
  }
  return [...result]
}
