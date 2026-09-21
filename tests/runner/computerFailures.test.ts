import {describe,expect,it} from 'vitest'
import {HttpError} from '../../src/server/errors.js'
import {ComputerError} from '../../src/runner/computers/container.js'
import {needsVmLease,softComputerFailure} from '../../src/runner/computers/computerFailures.js'

describe('computerFailures',()=>{
  it('treats pool/env codes and ComputerError as soft tool failures',()=>{
    expect(softComputerFailure(new ComputerError('computer_busy','电脑正在使用或需要核对停止状态'))).toBe(true)
    expect(softComputerFailure(new HttpError(409,'请先准备','computer_image_required'))).toBe(true)
    expect(softComputerFailure(new HttpError(502,'模型失败','run_failed'))).toBe(false)
    expect(softComputerFailure(new Error('random'))).toBe(false)
  })
  it('requires a VM lease only for computer_* and skill tools, not host or team tools',()=>{
    expect(needsVmLease('computer_shell')).toBe(true)
    expect(needsVmLease('computer_desktop_state')).toBe(true)
    expect(needsVmLease('skills_list',[],['skills_list'])).toBe(true)
    expect(needsVmLease('host_shell')).toBe(false)
    expect(needsVmLease('team_ping',['team_ping'])).toBe(false)
  })
})
