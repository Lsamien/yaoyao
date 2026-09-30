// @vitest-environment node
import { expect, it } from 'vitest'
import { normalizeUploadName } from '../../src/shared/uploadNames'

it.each([
  '人工智能合同综合质量评估系统V2.0-信息采集表-待确认.docx',
  'café-附件-📄.txt',
])('recovers a legacy Latin-1 decoding of %s exactly once', name => {
  const corrupted = Buffer.from(name, 'utf8').toString('latin1')
  expect(normalizeUploadName(corrupted)).toBe(name)
  expect(normalizeUploadName(normalizeUploadName(corrupted))).toBe(name)
})

it.each(['report.txt', '中文附件.docx', 'café.txt', 'ÿ.txt', '坏数据-äº.txt', 'äº.txt'])
  ('preserves names that cannot be safely recovered: %s', name => {
    expect(normalizeUploadName(name)).toBe(name)
  })
