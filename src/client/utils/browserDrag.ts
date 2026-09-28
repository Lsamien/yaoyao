import type {BrowserPointerAction} from '@shared/managedBrowser'
import {createUuid} from './id'

type Point={x:number;y:number}
/** One in-flight input, one latest move, and a final release. Never replay a failed movement. */
export class BrowserDragSession {
  readonly id=createUuid()
  readonly done:Promise<void>
  private resolve!:()=>void
  private queue:BrowserPointerAction[]=[]
  private running=false
  private ending=false
  private finished=false
  private heartbeat:ReturnType<typeof setInterval>
  private latest:Point
  constructor(start:Point,private send:(action:BrowserPointerAction)=>Promise<void>,private failed:(error:unknown)=>void){
    this.latest={x:start.x,y:start.y};this.done=new Promise(resolve=>{this.resolve=resolve})
    this.heartbeat=setInterval(()=>{if(!this.ending)this.move(this.latest)},1000)
    this.enqueue('start',start)
  }
  move(point:Point){if(!this.ending)this.enqueue('move',point)}
  end(point:Point){if(this.ending)return;this.ending=true;clearInterval(this.heartbeat);this.enqueue('end',point)}
  cancel(){
    if(this.finished)return this.done
    this.ending=true;clearInterval(this.heartbeat);this.queue=[];this.enqueue('cancel',this.latest)
    return this.done
  }
  private enqueue(phase:BrowserPointerAction['phase'],point:Point){
    // Type annotations do not strip the viewer's DOM element and pointer metadata.
    this.latest={x:point.x,y:point.y}
    const action:BrowserPointerAction={kind:'pointer',gestureId:this.id,phase,x:point.x,y:point.y}
    if(phase==='move'&&this.queue.at(-1)?.phase==='move')this.queue[this.queue.length-1]=action
    else this.queue.push(action)
    void this.flush()
  }
  private async flush(){
    if(this.running||this.finished)return
    this.running=true
    try{
      while(this.queue.length){
        const action=this.queue.shift()!
        await this.send(action)
        if(action.phase==='end'||action.phase==='cancel'){this.finish();return}
      }
    }catch(error){
      this.ending=true;this.queue=[];clearInterval(this.heartbeat)
      // The server may have executed a timed-out start/move. Release it explicitly.
      try{await this.send({kind:'pointer',gestureId:this.id,phase:'cancel',...this.latest})}catch{/* Runner also releases idle gestures. */}
      this.failed(error);this.finish()
    }finally{this.running=false}
  }
  private finish(){this.finished=true;this.ending=true;this.queue=[];clearInterval(this.heartbeat);this.resolve()}
}
