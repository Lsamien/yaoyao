export type WorkspaceLifecycleAction = 'archive' | 'restore' | 'delete'

export interface WorkspaceLifecyclePreview {
  name: string
  kind: 'direct' | 'group'
  groups: Array<{ id: string; name: string; administrator: boolean }>
  confirmationToken: string
}
