// Original two-eye geometry from LaoA-GrokBot (MIT). See THIRD_PARTY_NOTICES.md.
import { LAOA_DATA } from './laoa-data'
export const FACE_BOX = 228.541
export const FACE_CENTRE: [number, number] = [120, 122.5]
export const GAZE_TRAVEL = { x: 13.2, y: 8.4 }
export type Ring = [number, number][]
/** Preserve the authored eye positions, including each expression's look direction. */
export const EXPRESSIONS: Ring[][] = LAOA_DATA.expressions.map(ex => ex.map(ring => ring.map(p => [p[0], p[1]])))
export const EXPRESSION_COUNT = EXPRESSIONS.length
