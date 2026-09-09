export interface ComputerFrame {id:string;generation:number;data:string;width:number;height:number;capturedAt:number}
export interface ComputerControlStatus {mode:'off'|'idle'|'agent'|'pausing'|'human'|'resuming'|'error';generation?:number;controlId?:string;canResume?:boolean;error?:string}
export type ComputerInput =
  | {kind:'click';x:number;y:number;button?:'left'|'right'|'middle';count?:number}
  | {kind:'drag';fromX:number;fromY:number;toX:number;toY:number}
  | {kind:'text';text:string}
  | {kind:'key';key:string;modifiers?:string[]}
  | {kind:'scroll';direction:'up'|'down'|'left'|'right';amount?:number}
