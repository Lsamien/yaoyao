import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import ProviderLogo from '@/components/common/ProviderLogo.vue'
import { mcpProviderLogo } from '@shared/botProviderLogos'
import type { BotMcpPlugin } from '@shared/workspacePlugins'

it('uses bundled logos offline and falls back through the catalog logo to an initial', async () => {
  const remote = 'https://logos.composio.dev/api/github'
  const wrapper = mount(ProviderLogo, { props: { name: 'GitHub', logo: remote, bundledLogo: '/provider-logos/github.svg' } })
  expect(wrapper.get('img').attributes('src')).toBe('/provider-logos/github.svg')
  await wrapper.get('img').trigger('error')
  expect(wrapper.get('img').attributes('src')).toBe(remote)
  expect(wrapper.get('img').attributes('referrerpolicy')).toBe('no-referrer')
  await wrapper.get('img').trigger('error')
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.text()).toBe('G')
  await wrapper.setProps({ logo: 'https://logos.composio.dev/api/github?version=2' })
  expect(wrapper.get('img').attributes('src')).toBe('/provider-logos/github.svg')
  wrapper.unmount()
})

it.each(['javascript:alert(1)', 'https://unknown.example/logo.svg', 'https://user:secret@logos.composio.dev/api/github', '//logos.composio.dev/api/github'])('keeps a readable placeholder for an unsupported logo: %s', logo => {
  const wrapper = mount(ProviderLogo, { props: { name: '供应商', logo } })
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.text()).toBe('供')
  wrapper.unmount()
})

it.each([
  [{ name: '工作代码', transport: 'http', url: 'https://api.githubcopilot.com/mcp' }, 'github'],
  [{ name: '工作文档', transport: 'http', url: 'https://mcp.notion.com/mcp' }, 'notion'],
  [{ name: '团队沟通', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack@1.0.0'] }, 'slack'],
  [{ name: 'GitHub MCP 服务', transport: 'stdio', command: 'local-mcp' }, 'github'],
  [{ name: '未知工具', transport: 'http', url: 'https://github.com.example.test/mcp' }, undefined],
] as const)('recognizes MCP providers without matching lookalike hosts: %o', (definition, provider) => {
  expect(mcpProviderLogo(definition as unknown as BotMcpPlugin)).toBe(provider ? `/provider-logos/${provider}.svg` : undefined)
})
