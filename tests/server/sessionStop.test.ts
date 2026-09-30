// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import {waitForHermesSessionIdle} from '../../src/server/sessionStop'

afterEach(()=>vi.useRealTimers())
it('waits beyond the interrupt receipt until the owned native session is idle',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({sessions:[{id:'other',status:'idle'},{id:'mine',status:'working'}]})
    .mockResolvedValueOnce({sessions:[{id:'mine',status:'idle'}]})
  await waitForHermesSessionIdle(rpc,'mine','default',{pollMs:1})
  expect(rpc).toHaveBeenCalledTimes(2)
  expect(rpc).toHaveBeenCalledWith('session.active_list',{profile:'default',current_session_id:'mine'})
})
it('accepts a finalized session disappearing, but refuses malformed stop evidence',async()=>{
  await waitForHermesSessionIdle(async()=>({sessions:[]}),'mine','default')
  await expect(waitForHermesSessionIdle(async()=>({ok:true}),'mine','default')).rejects.toMatchObject({code:'session_stop_unconfirmed'})
})
it('times out without treating an acknowledgement or a sibling idle session as termination',async()=>{
  const pending=waitForHermesSessionIdle(async()=>({sessions:[{id:'mine',status:'working'},{id:'other',status:'idle'}]}),'mine','default',{timeoutMs:200,pollMs:100})
  const rejected=expect(pending).rejects.toMatchObject({code:'session_still_stopping'})
  await rejected
})
