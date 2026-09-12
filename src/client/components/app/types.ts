export type SidebarItemBase = {
  id: string
  title: string
  subtitle?: string
  meta?: string
  section?: string
  active?: boolean
  unread?: number
  unreadDot?: boolean
  pinned?: boolean
  nested?: boolean
  topic?: boolean
  showMore?: boolean
  expandable?: boolean
  expanded?: boolean
  status?: 'online' | 'working' | 'offline'
  icon?: 'chat' | 'groups' | 'file' | 'image' | 'video' | 'audio' | 'link' | 'artifacts' | 'branch' | 'topic' | 'chevron-left' | 'plus' | 'archive'
  avatarKind?: 'agent' | 'team'
  avatarActivityKey?: number
  avatarState?: 'idle' | 'working' | 'waiting' | 'loading' | 'success' | 'failure' | 'notifying'
  avatar?: string
  avatarFallbackKey?: string
  avatarMembers?: Array<{ activityKey?: number; name: string; avatar?: string; state?: 'idle' | 'working' | 'waiting' | 'loading' | 'success' | 'failure' | 'notifying' }>
  emptyText?: string
}

export type SidebarItem = SidebarItemBase & { children?: SidebarItemBase[] }
