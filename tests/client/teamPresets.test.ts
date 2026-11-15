import { describe, expect, it } from 'vitest'
import { TEAM_PRESETS } from '@/components/groups/teamPresets'

describe('team presets', () => {
  it('provides office and development presets with unique roles within the Agent limit', () => {
    expect(TEAM_PRESETS.map(preset => preset.name)).toEqual([
      '信息收集团队', '产品设计团队', '软件开发团队', '文案书写团队',
      '项目管理团队', '数据分析团队', '会议协作团队', '运维保障团队',
    ])
    for (const preset of TEAM_PRESETS) {
      expect(preset.roles.length).toBeGreaterThanOrEqual(4)
      expect(preset.roles.length).toBeLessThanOrEqual(8)
      expect(new Set(preset.roles.map(role => role.name)).size).toBe(preset.roles.length)
      expect(preset.roles.filter(role => role.host)).toHaveLength(1)
    }
  })
})
