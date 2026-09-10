import { createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import KanbanCard from '@/components/kanban/KanbanCard.vue'
import KanbanColumn from '@/components/kanban/KanbanColumn.vue'
import KanbanTaskDrawer from '@/components/kanban/KanbanTaskDrawer.vue'
import KanbanView from '@/views/KanbanView.vue'
import { setApiCsrfToken } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useKanbanStore } from '@/stores/kanban'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setApiCsrfToken('')
  document.body.innerHTML = ''
})

describe('Kanban components', () => {
  it('offers a mobile-safe status menu and emits an allowed move', async () => {
    const wrapper = mount(KanbanCard, {
      props: {
        task: { id: 'task-a', title: '移动端状态', status: 'todo', assignee: 'yaoyao' },
        columns: ['todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'],
        canEdit: true,
      },
      global: { stubs: { AppIcon: true } },
    })
    const options = wrapper.findAll('option').map(option => option.attributes('value'))
    expect(options).toEqual(['todo', 'ready', 'blocked', 'done'])
    await wrapper.get('select').setValue('ready')
    expect(wrapper.emitted('move')).toEqual([[
      expect.objectContaining({ id: 'task-a' }),
      'ready',
    ]])
  })

  it('accepts desktop drops only on operator-owned status columns', async () => {
    const transfer = { dropEffect: '', getData: () => 'task-a' }
    const wrapper = mount(KanbanColumn, {
      props: {
        column: { name: 'ready', tasks: [] },
        columns: ['todo', 'ready', 'running'],
        canEdit: true,
      },
      global: { stubs: { AppIcon: true, KanbanCard: true } },
    })
    await wrapper.get('.kanban-column').trigger('dragover', { dataTransfer: transfer })
    await wrapper.get('.kanban-column').trigger('drop', { dataTransfer: transfer })
    expect(wrapper.emitted('dropTask')).toEqual([['task-a', 'ready']])

    await wrapper.setProps({ column: { name: 'running', tasks: [] } })
    await wrapper.get('.kanban-column').trigger('drop', { dataTransfer: transfer })
    expect(wrapper.emitted('dropTask')).toHaveLength(1)
  })

  it('renders task comments, runs, events, and a genuine read-only state', () => {
    const wrapper = mount(KanbanTaskDrawer, {
      props: {
        canEdit: false,
        columns: ['todo', 'ready', 'running', 'done'],
        profiles: [{ name: 'yaoyao', is_default: true }],
        detail: {
          task: { id: 'task-a', title: '发布核对', body: '检查全部端', status: 'running', assignee: 'yaoyao' },
          comments: [{ id: 1, author: 'admin', body: '请补充验收', created_at: 1 }],
          events: [{ id: 1, kind: 'claimed', created_at: 2 }],
          links: { parents: [], children: [] },
          runs: [{ id: 1, profile: 'yaoyao', status: 'running', summary: '正在执行' }],
        },
      },
      global: { stubs: { AppIcon: true } },
    })
    expect(wrapper.text()).toContain('编辑仅限管理员')
    expect(wrapper.text()).toContain('请补充验收')
    expect(wrapper.text()).toContain('正在执行')
    expect(wrapper.text()).toContain('机器人开始处理')
    expect(wrapper.findAll('input:disabled, textarea:disabled, select:disabled').length).toBeGreaterThan(0)
    expect(wrapper.find('.kanban-comment-form').exists()).toBe(false)
    expect(wrapper.find('.kanban-task-form__actions').exists()).toBe(false)
  })

  it('patches only edited fields so a running task can be renamed safely', async () => {
    const detail = {
      task: { id: 'task-running', title: '旧标题', body: '描述', status: 'running', assignee: 'yaoyao', priority: 2 },
      comments: [], events: [], links: { parents: [], children: [] }, runs: [],
    }
    const wrapper = mount(KanbanTaskDrawer, {
      props: { canEdit: true, columns: ['todo', 'ready', 'running', 'done'], profiles: [{ name: 'yaoyao', is_default: true }], detail },
      global: { stubs: { AppIcon: true } },
    })
    await wrapper.get('.kanban-task-form input[required]').setValue('新标题')
    await wrapper.get('.kanban-task-form').trigger('submit')
    expect(wrapper.emitted('save')).toEqual([[{ title: '新标题' }]])

    await wrapper.setProps({ detail: { ...detail, task: { ...detail.task, status: 'done', latest_summary: '远端轮询更新' } } })
    expect((wrapper.get('.kanban-task-form input[required]').element as HTMLInputElement).value).toBe('新标题')
    expect((wrapper.get('.kanban-task-form select').element as HTMLSelectElement).value).toBe('done')
    await wrapper.get('.kanban-task-form').trigger('submit')
    expect(wrapper.emitted('save')?.at(-1)).toEqual([{ title: '新标题' }])
    await wrapper.setProps({ detail: { ...detail, task: { ...detail.task, title: '新标题', status: 'done' } } })
    expect(wrapper.get<HTMLButtonElement>('.kanban-task-form .primary-button').element.disabled).toBe(true)
  })
})

describe('Kanban view', () => {
  it('loads the official snapshot and presents the board in the shared workspace shell', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path.endsWith('/status')) return Response.json({ available: true, version: '1.0.0' })
      if (path.endsWith('/boards')) return Response.json({ boards: [{ slug: 'default', name: '默认看板', total: 1 }, { slug: 'mobile', name: '移动看板', total: 1 }], current: 'default' })
      if (path.endsWith('/profiles')) return Response.json({ profiles: [{ name: 'yaoyao', is_default: true }] })
      if (path.includes('/board?')) return Response.json({
        columns: [{ name: 'todo', tasks: [{ id: 'task-a', title: 'Web 看板验收', status: 'todo', assignee: 'yaoyao' }] }, { name: 'ready', tasks: [] }],
        tenants: [], assignees: ['yaoyao'], latest_event_id: 1, now: 2,
      })
      return Response.json({ ok: true })
    }))
    setApiCsrfToken('csrf-view')
    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/kanban/:boardSlug?', component: KanbanView }],
    })
    await router.push('/kanban')
    await router.isReady()
    const auth = useAuthStore(pinia)
    auth.status = 'authenticated'
    auth.user = { id: 'admin', username: 'admin', role: 'admin' }
    const WorkspaceStub = defineComponent({
      emits: ['closeInspector'],
      template: '<div class="workspace-stub"><slot name="sidebar-action"/><slot name="sidebar"/><slot/><slot name="inspector"/></div>',
    })
    const wrapper = mount(KanbanView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        stubs: {
          WorkspaceView: WorkspaceStub,
          KanbanTaskDialog: true,
          KanbanBoardDialog: true,
          AppIcon: true,
          YaoYaoSidebarIcon: true,
        },
      },
    })
    await vi.waitFor(() => expect(wrapper.text()).toContain('Web 看板验收'))
    expect(wrapper.text()).toContain('默认看板')
    expect(wrapper.text()).toContain('待办')
    expect(wrapper.get('.kanban-columns').attributes('aria-label')).toBe('任务看板')

    await router.push('/kanban/mobile')
    await vi.waitFor(() => expect(wrapper.text()).toContain('移动看板'))
    expect(useKanbanStore(pinia).selectedBoardSlug).toBe('mobile')
    router.back()
    await vi.waitFor(() => expect(useKanbanStore(pinia).selectedBoardSlug).toBe('default'))
    wrapper.unmount()
  })

  it('does not start polling when the view unmounts during initialization', async () => {
    const boardResponse = deferred<Response>()
    let boardReads = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path.endsWith('/status')) return Response.json({ available: true })
      if (path.endsWith('/boards')) return Response.json({ boards: [{ slug: 'default', total: 0 }], current: 'default' })
      if (path.endsWith('/profiles')) return Response.json({ profiles: [] })
      if (path.includes('/board?')) {
        boardReads += 1
        return boardResponse.promise
      }
      return Response.json({ ok: true })
    }))
    const interval = vi.spyOn(window, 'setInterval')
    const pinia = createPinia()
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/kanban/:boardSlug?', component: KanbanView }] })
    await router.push('/kanban')
    await router.isReady()
    const auth = useAuthStore(pinia)
    auth.status = 'authenticated'
    auth.user = { id: 'admin-unmount', username: 'admin', role: 'admin' }
    const WorkspaceStub = defineComponent({ template: '<div><slot name="sidebar-action"/><slot name="sidebar"/><slot/><slot name="inspector"/></div>' })
    const wrapper = mount(KanbanView, {
      global: {
        plugins: [pinia, router],
        stubs: { WorkspaceView: WorkspaceStub, KanbanTaskDialog: true, KanbanBoardDialog: true, AppIcon: true, YaoYaoSidebarIcon: true },
      },
    })
    await vi.waitFor(() => expect(boardReads).toBe(1))
    wrapper.unmount()
    boardResponse.resolve(Response.json({ columns: [], tenants: [], assignees: [], latest_event_id: 0, now: 1 }))
    await new Promise(resolve => window.setTimeout(resolve, 15))
    expect(interval).not.toHaveBeenCalled()
    interval.mockRestore()
  })
})
