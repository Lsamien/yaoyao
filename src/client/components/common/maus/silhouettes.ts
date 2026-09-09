// Shared LaoA-GrokBot geometry; see THIRD_PARTY_NOTICES.md.
import type { CursorSilhouette } from './cursor-engine'
import { LAOA_DATA } from './laoa-data'
function silhouette(name: string, geometry: {path:string;anchor:readonly number[];viewport:readonly number[]}): CursorSilhouette {
  const [x,y,scale] = geometry.anchor
  return {name,fit:'',body:`<path d="${geometry.path}" fill="{{GRADIENT}}"/>`,clip:`<path d="${geometry.path}"/>`,anchor:{x,y,scale},viewBox:geometry.viewport.join(' ')}
}
export const MASCOT_SILHOUETTES = Object.fromEntries(Object.entries(LAOA_DATA.shapes).map(([id,value]) => [id==='ellipse'?'oval':id,silhouette(id,value)])) as Record<string,CursorSilhouette>
export const LAOA_BODIES = Object.fromEntries(Object.entries(LAOA_DATA.bodies).map(([id,value]) => [id,silhouette(id,value)])) as Record<keyof typeof LAOA_DATA.bodies,CursorSilhouette>
