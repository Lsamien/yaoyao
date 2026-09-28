import {afterEach,expect,it,vi} from 'vitest'
import {flushPromises} from '@vue/test-utils'
import {BrowserDragSession} from '@/utils/browserDrag'
import type {BrowserPointerAction} from '@shared/managedBrowser'

afterEach(()=>vi.useRealTimers())
it('copies only frame coordinates from the viewer pointer state into every request',async()=>{
  vi.useFakeTimers()
  const start={x:1,y:2,clientX:101,clientY:102,pointerId:3,element:document.createElement('img')}
  const send=vi.fn(async(_action:BrowserPointerAction)=>{}),session=new BrowserDragSession(start,send,vi.fn())
  start.x=99
  await flushPromises();await vi.advanceTimersByTimeAsync(1000)
  session.move({...start,x:30,y:40});await flushPromises()
  session.end({...start,x:50,y:60});await session.done
  expect(send.mock.calls.map(([action])=>action)).toEqual([
    {kind:'pointer',gestureId:session.id,phase:'start',x:1,y:2},
    {kind:'pointer',gestureId:session.id,phase:'move',x:1,y:2},
    {kind:'pointer',gestureId:session.id,phase:'move',x:30,y:40},
    {kind:'pointer',gestureId:session.id,phase:'end',x:50,y:60},
  ])
})
it('serializes input and coalesces pending movement without losing the final point',async()=>{
  vi.useFakeTimers()
  let release!:()=>void
  const send=vi.fn(async(_action:BrowserPointerAction)=>{})
  send.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
  const failed=vi.fn(),session=new BrowserDragSession({x:1,y:2},send,failed)
  session.move({x:10,y:20});session.move({x:30,y:40});session.end({x:50,y:60})
  expect(send).toHaveBeenCalledTimes(1)
  release();await session.done
  expect(send.mock.calls.map(([action])=>[action.phase,action.x,action.y])).toEqual([['start',1,2],['move',30,40],['end',50,60]])
  expect(new Set(send.mock.calls.map(([action])=>action.gestureId)).size).toBe(1)
  await vi.advanceTimersByTimeAsync(10000);expect(send).toHaveBeenCalledTimes(3);expect(failed).not.toHaveBeenCalled()
})
it('keeps a stationary hold alive and discards queued moves on cancellation',async()=>{
  vi.useFakeTimers()
  const send=vi.fn(async(_action:BrowserPointerAction)=>{}),session=new BrowserDragSession({x:1,y:2},send,vi.fn())
  await flushPromises();await vi.advanceTimersByTimeAsync(1000)
  expect(send.mock.calls.map(([action])=>action.phase)).toEqual(['start','move'])
  let release!:()=>void
  send.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
  session.move({x:10,y:20});session.move({x:30,y:40})
  const done=session.cancel();release();await done
  expect(send.mock.calls.map(([action])=>action.phase)).toEqual(['start','move','move','cancel'])
  await vi.advanceTimersByTimeAsync(10000);expect(send).toHaveBeenCalledTimes(4)
})
it('releases an uncertain input after failure without replaying it',async()=>{
  vi.useFakeTimers()
  const send=vi.fn(async(_action:BrowserPointerAction)=>{}).mockRejectedValueOnce(new Error('timeout')),failed=vi.fn()
  const start={x:1,y:2,clientX:101,clientY:102,pointerId:3,element:document.createElement('img')}
  const session=new BrowserDragSession(start,send,failed)
  await session.done
  expect(send.mock.calls.map(([action])=>action)).toEqual([
    {kind:'pointer',gestureId:session.id,phase:'start',x:1,y:2},
    {kind:'pointer',gestureId:session.id,phase:'cancel',x:1,y:2},
  ])
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({message:'timeout'}))
  await vi.advanceTimersByTimeAsync(10000);expect(send).toHaveBeenCalledTimes(2)
})
