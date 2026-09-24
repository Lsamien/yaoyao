import {MANAGED_BROWSER_TOOLS,MANAGED_BROWSER_VM_TOOLS} from './managedBrowserTools.js'
import type { DesktopEnvironmentSnapshot, WorkspaceEnvironment } from '../shared/botEnvironment.js'
import type { WorkspaceAgent } from '../shared/workspace.js'
import type { HostToolSettings } from './hostToolSettings.js'
import { DESKTOP_ENVIRONMENT_TOOLS, DESKTOP_FILE_TOOL_IDS } from './desktopEnvironments.js'
import { GROK_COMPUTER_TOOLS } from './grokCloud.js'
import { VM_COMPUTER_TOOLS } from './vmComputer.js'

/** One snapshot drives model instructions, mounted computer tools and inspection. */
export function buildWorkspaceEnvironment(input: {
  agent: WorkspaceAgent
  globals: HostToolSettings
  desktop: DesktopEnvironmentSnapshot
  bridge: boolean
  cloud: boolean
  plugins: boolean
  managedBrowser?: boolean
}): WorkspaceEnvironment {
  const { agent, globals, desktop } = input
  const eligible = !agent.archived && !agent.remoteAgentId
  const vm = !!eligible && globals.vm && input.bridge
  const cloud = !!eligible && globals.cloud && input.cloud
  return {
    version: 1, capturedAt: desktop.capturedAt, execution: { nodeId: agent.nodeId, profile: agent.profile },
    open: { computer: globals.scriptMachine, server: globals.serverComputer, vm: globals.vm, cloud: globals.cloud },
    desktop,
    tools: {
      desktopView: !!eligible && desktop.hosts.some(host => host.capabilities.view.enabled),
      desktopFile: !!eligible && desktop.hosts.some(host => host.capabilities.fileRead.enabled),
      vm, cloud, plugins: input.plugins,
      ...(eligible && input.bridge && globals.managedBrowser && input.managedBrowser ? {managedBrowser:true} : {}),
    },
    virtual: {
      vm: { status: !globals.vm ? 'disabled' : vm ? 'on_demand' : 'bridge_unavailable', environmentId: agent.computerEnvironmentId ?? agent.id },
      cloud: { status: !globals.cloud ? 'disabled' : cloud ? 'on_demand' : 'not_configured', ...(cloud ? { cwd: '/workspace' } : {}) },
    },
    fileTransferMaxMiB: globals.fileTransferMaxMiB,
  }
}

export function workspaceEnvironmentTools(environment: WorkspaceEnvironment) {
  const { tools, fileTransferMaxMiB } = environment
  return [
    ...(tools.managedBrowser ? MANAGED_BROWSER_TOOLS : []),
    ...(tools.managedBrowser && tools.vm ? MANAGED_BROWSER_VM_TOOLS : []),
    ...(tools.cloud ? GROK_COMPUTER_TOOLS : []),
    ...(tools.vm ? VM_COMPUTER_TOOLS : []),
    ...DESKTOP_ENVIRONMENT_TOOLS.filter(tool =>
      (tools.desktopView && ['desktop_environment_view', 'desktop_environment_action'].includes(tool.id)) ||
      (tools.desktopFile && DESKTOP_FILE_TOOL_IDS.has(tool.id)))
      .map(tool => tool.id === 'desktop_file_copy' ? { ...tool, description: tool.description.replace('25 MiB', `${fileTransferMaxMiB} MiB`) } : tool),
  ]
}
