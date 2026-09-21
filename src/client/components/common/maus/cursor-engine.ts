import { LAOA_DATA } from './laoa-data'
// Adapted from OpenMausBot (3a84701), Apache-2.0. See THIRD_PARTY_NOTICES.md.
/**
 * CursorAvatar — an animated mascot built on the "cursor" silhouette.
 *
 * Data and frame functions retained from OpenMausBot; the host below is framework-neutral.
 *
 *   import CursorAvatar from './CursorAvatar'
 *
 *   <CursorAvatar state="thinking" silhouette={MASCOT_BODIES.cursor} size={160} />
 *
 * The state drives everything — which expressions cycle, how often, and when it blinks.
 * Set `state` and it animates itself; see CURSOR_STATES for the full list.
 *
 * Props of note:
 *   state        one of CURSOR_STATES
 *   expression   pin a single face and stop the cycling
 *   lookAround   how much each expression glances around. 0 = always straight ahead
 *   gaze / turn  aim the eyes, or rotate the head around its implied sphere
 *
 * Made with Blob Studio.
 */

import { MASCOT_BODIES } from "./mascot-bodies"
import {
  EXPRESSIONS,
  EXPRESSION_COUNT,
  FACE_BOX,
  FACE_CENTRE,
  GAZE_TRAVEL,
  type Ring,
} from "./cursor-face-data"

export {
  EXPRESSIONS,
  EXPRESSION_COUNT,
  FACE_BOX,
  FACE_CENTRE,
  GAZE_TRAVEL,
}
export type { Ring }

/* ------------------------------------------------------------------- shape */

export interface CursorSilhouette {
  viewBox?: string
  /** Human-readable name, used for the accessible label. */
  name: string
  /** Transform mapping the artwork into the 228.541-unit face box. '' for none. */
  fit: string
  /** SVG markup for the body. The token {{GRADIENT}} is replaced with the instance gradient. */
  body: string
  /** SVG markup defining the clip region — the union of the silhouette's filled shapes. */
  clip: string
  /** Where the face sits inside the silhouette, in face-space units. */
  anchor: { x: number; y: number; scale: number }
}

// The generator solves this body's face placement once; `MASCOT_BODIES.cursor`
// is the single source of truth desktop and iOS both build from. Its shape
// carries one extra field (`id`) that `CursorSilhouette` does not, so it is
// derived here rather than assigned directly.
const { id: _cursorBodyId, ...cursorSilhouette } = MASCOT_BODIES.cursor;
export const DEFAULT_SILHOUETTE: CursorSilhouette = cursorSilhouette;

export const DEFAULT_GRADIENT: [string, string, string] = ["#9FE6B5","#3FAE6E","#1C7A4C"]

const VIEW_BOX = `-15 -15 ${FACE_BOX + 30} ${FACE_BOX + 30}`
const SPHERE_C = 114.2705
const SPHERE_R = 105

/* ------------------------------------------------------------------ motion */

/**
 * How the body itself moves. The face engine on its own leaves the silhouette perfectly
 * still, which reads as dead for states literally named `bouncing` or `spawning`.
 *
 * All of this is shape-agnostic — it moves whatever silhouette it is given, so an uploaded
 * logo animates exactly like the built-in circle.
 *
 *   bob     vertical travel, [amplitude in face units, period ms]
 *   sway    rotation, [degrees, period ms]
 *   pulse   uniform scale, [fraction, period ms] — breathing
 *   circle  orbital drift, [radius, period ms]
 *   jitter  fast nervous shake, [amplitude, period ms]
 *   tilt    constant lean, degrees
 *   squash  0..1, how much a bob squashes the body at the bottom of its arc
 *   enter   one-shot on entering the state, [starting scale, duration ms]
 *   settle  scale it eases to and holds, for exits like powering-down
 */
export interface BodyMotion {
  bob?: [number, number]
  sway?: [number, number]
  pulse?: [number, number]
  circle?: [number, number]
  jitter?: [number, number]
  tilt?: number
  squash?: number
  enter?: [number, number]
  settle?: number
}

export const MOTION = {
  // Lifecycle — quiet, breathing, alive but not busy.
  sleeping: { pulse: [0.028, 4600], tilt: 2 },
  waking: { enter: [0.92, 700], pulse: [0.03, 2200] },
  idle: { pulse: [0.014, 3600] },
  listening: { bob: [2, 2600], pulse: [0.012, 2600] },
  thinking: { sway: [1.6, 3000], pulse: [0.01, 3000] },
  searching: { bob: [3, 1400], sway: [2.2, 1400] },
  working: { bob: [2.5, 900], squash: 0.22 },

  // Reactions — the loud half.
  excited: { bob: [9, 520], sway: [3, 1040], squash: 0.35 },
  surprised: { enter: [1.14, 340], jitter: [0.8, 120] },
  suspicious: { sway: [2.4, 2600], tilt: -3 },
  angry: { jitter: [1.3, 95], tilt: 2 },
  drowsy: { pulse: [0.026, 5000], tilt: 3 },
  happy: { bob: [5, 820], squash: 0.28 },
  curious: { sway: [3.4, 1900], tilt: -4 },
  confused: { sway: [3, 2200] },
  bored: { pulse: [0.016, 5200], tilt: 2 },
  proud: { bob: [1.6, 2400], pulse: [0.02, 2400] },
  shy: { pulse: [0.016, 3000], tilt: 4 },
  sad: { pulse: [0.02, 4600], tilt: 3 },
  laughing: { bob: [7, 430], squash: 0.4 },
  scared: { jitter: [2.2, 75] },
  playful: { bob: [6, 620], sway: [5, 1240], squash: 0.3 },
  celebrate: { bob: [10, 480], sway: [4, 960], squash: 0.35 },

  // Agent morphs — the mascot standing in for a process.
  orbit: { circle: [6, 3200] },
  radar: { sway: [6, 2400], pulse: [0.012, 2400] },
  progress: { pulse: [0.022, 1600] },

  // Product cycle.
  spawning: { enter: [0.02, 820], pulse: [0.014, 3600] },
  humming: { pulse: [0.016, 2800] },
  loading: { sway: [2.2, 1500], pulse: [0.012, 1500] },
  dictating: { bob: [2, 2000] },
  writing: { bob: [1.6, 1100] },
  sending: { bob: [3, 900] },
  receiving: { bob: [3, 900] },
  uploading: { bob: [3, 1000] },
  notifying: { bob: [4, 700], sway: [2.5, 700] },
  alerting: { jitter: [2.6, 85] },
  dragging: { tilt: -6, sway: [2, 900] },
  bouncing: { bob: [12, 560], squash: 0.45 },
  'powering-down': { settle: 0.05, tilt: 4 },
} satisfies Record<CursorState, BodyMotion>

/** How long a `settle` takes to reach its resting scale. */
const SETTLE_MS = 1400

/* ----------------------------------------------------------------- effects */

/**
 * Confetti, motion ribbons, and glyph morphs.
 *
 * All three are shape-agnostic: they orbit, burst around, or stand in for whatever
 * silhouette they are given, so an uploaded logo behaves exactly like the built-in circle.
 *
 * These layers are driven imperatively from the frame loop rather than through React
 * state. A celebrate burst is ~14 elements changing every frame, and a page showing all
 * states at once would otherwise re-render continuously.
 */

const TAU = Math.PI * 2

/** Deterministic per-particle randomness — same seed, same particle, every run. */
const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

const CONFETTI_COLORS = ['#F472B6', '#C084FC', '#818CF8', '#38BDF8', '#34D399', '#FACC15', '#FB7185']
const RIBBON_COLORS = ['#4ADE80', '#34D399', '#22D3EE', '#60A5FA']

export interface ConfettiSpec {
  /** How many pieces are in flight per burst. */
  count: number
  /** Milliseconds between bursts. */
  period: number
  /** How long one piece lives, ms. */
  life: number
  /** Radius the pieces launch from, so a burst clears the face instead of covering it. */
  origin: number
  /** How far pieces travel beyond that, in face units. */
  spread: number
}

export interface TrailSpec {
  /** How many ribbons orbit the body. */
  count: number
  /** Milliseconds for one full orbit. */
  period: number
  /** Orbit radius, in face units. */
  radius: number
}

export interface GlyphSpec {
  /** Markup drawn in place of the body. {{GRADIENT}} is replaced with the body paint. */
  markup: string
  /** Milliseconds between appearances. */
  period: number
  /** How long the glyph is held, ms. */
  hold: number
}

export interface StateEffects {
  confetti?: ConfettiSpec
  trails?: TrailSpec
  glyph?: GlyphSpec
}

interface EffectsByState extends Partial<Record<CursorState, StateEffects>> {}

/**
 * The exclamation mark the mascot becomes when something needs attention — drawn as a
 * tapered bar and a dot so it reads as a character rather than a rectangle.
 */
const GLYPH_BANG =
  '<path fill="{{GRADIENT}}" d="M99 58 Q99 43 114.3 43 Q129.6 43 129.6 58 L123 150 Q122 161 114.3 161 Q106.6 161 105.6 150 Z"/>' +
  '<circle fill="{{GRADIENT}}" cx="114.3" cy="188" r="15"/>'

/** The question mark for genuine confusion. Stroked, so it stays light against the body. */
const GLYPH_QUERY =
  '<path fill="none" stroke="{{GRADIENT}}" stroke-width="19" stroke-linecap="round" ' +
  'd="M88 76 A27 27 0 1 1 114.3 112 L114.3 132"/>' +
  '<circle fill="{{GRADIENT}}" cx="114.3" cy="170" r="13"/>'

export const EFFECTS: EffectsByState = {
  // Celebration — the loud burst.
  // Travel is deliberately bounded: the viewBox only carries 15 units of margin, so a
  // piece thrown much past ~130 from centre would be clipped mid-flight.
  celebrate: { confetti: { count: 16, period: 1500, life: 1300, origin: 74, spread: 54 } },
  excited: { confetti: { count: 9, period: 2000, life: 1100, origin: 72, spread: 44 } },
  laughing: { confetti: { count: 7, period: 2400, life: 1000, origin: 70, spread: 38 } },

  // Work in flight — ribbons circling the body.
  working: { trails: { count: 3, period: 2200, radius: 126 } },
  orbit: { trails: { count: 3, period: 2600, radius: 128 } },
  radar: { trails: { count: 2, period: 2000, radius: 132 } },
  progress: { trails: { count: 3, period: 1800, radius: 124 } },
  loading: { trails: { count: 2, period: 2200, radius: 126 } },
  uploading: { trails: { count: 2, period: 1700, radius: 122 } },
  sending: { trails: { count: 2, period: 1500, radius: 120 } },
  receiving: { trails: { count: 2, period: 1500, radius: 120 } },

  // The mascot standing aside to show a symbol.
  alerting: { glyph: { markup: GLYPH_BANG, period: 2600, hold: 1100 } },
  notifying: { glyph: { markup: GLYPH_BANG, period: 4200, hold: 900 } },
  confused: { glyph: { markup: GLYPH_QUERY, period: 5200, hold: 1200 } },
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Grows or shrinks a layer's pool of <path> children to exactly `count`. */
function poolPaths(layer: SVGGElement, count: number): SVGPathElement[] {
  while (layer.childNodes.length > count) layer.removeChild(layer.lastChild!)
  while (layer.childNodes.length < count) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('fill', 'none')
    layer.appendChild(path)
  }
  return Array.from(layer.querySelectorAll<SVGPathElement>(':scope > path'))
}

/** Confetti: short curved strokes thrown outward, arcing down as they fade. */
function drawConfetti(
  layer: SVGGElement,
  spec: ConfettiSpec,
  elapsed: number,
  strength: number,
  cx: number,
  cy: number
) {
  const paths = poolPaths(layer, spec.count)
  for (let i = 0; i < spec.count; i++) {
    const path = paths[i]
    const seedA = hash01(i + 1)
    const seedB = hash01(i + 41)
    const seedC = hash01(i + 91)

    // Stagger the pieces across the burst window so they don't leave as one wall.
    const t = (((elapsed + seedC * spec.period) % spec.period) / spec.life) * 1
    if (t > 1) {
      path.setAttribute('opacity', '0')
      continue
    }

    const angle = seedA * TAU
    const travel = spec.spread * (0.45 + seedB * 0.55) * (1 - (1 - t) * (1 - t))
    const distance = (spec.origin + travel) * strength
    const gravity = 34 * strength * t * t
    const x = cx + Math.cos(angle) * distance
    const y = cy + Math.sin(angle) * distance + gravity
    const length = 11 + seedB * 12
    const spin = angle + (seedC - 0.5) * 5 * t
    const ex = x + Math.cos(spin) * length
    const ey = y + Math.sin(spin) * length
    // A slight bend reads as paper rather than a matchstick.
    const bend = (seedA - 0.5) * length * 0.7
    const mx = (x + ex) / 2 - Math.sin(spin) * bend
    const my = (y + ey) / 2 + Math.cos(spin) * bend

    path.setAttribute('d', `M${x.toFixed(1)} ${y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`)
    path.setAttribute('stroke', CONFETTI_COLORS[i % CONFETTI_COLORS.length])
    path.setAttribute('stroke-width', (4 + seedB * 2.4).toFixed(1))
    path.setAttribute('opacity', (t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88).toFixed(3))
  }
}

/** Ribbons: arcs sweeping around the body on their own periods. */
function drawTrails(
  layer: SVGGElement,
  spec: TrailSpec,
  elapsed: number,
  strength: number,
  cx: number,
  cy: number
) {
  const paths = poolPaths(layer, spec.count)
  const SAMPLES = 12
  for (let i = 0; i < spec.count; i++) {
    const path = paths[i]
    const seedA = hash01(i + 3)
    const seedB = hash01(i + 29)
    const direction = i % 2 === 0 ? 1 : -1
    const period = spec.period * (0.8 + seedA * 0.5)
    const radius = spec.radius * strength * (0.78 + seedB * 0.4)
    const start = direction * (elapsed / period) * TAU + seedA * TAU
    const span = 0.85 + seedB * 0.7

    let d = ''
    for (let s = 0; s <= SAMPLES; s++) {
      const k = s / SAMPLES
      const angle = start + span * k
      // Breathe the radius along the arc so the ribbon curls instead of tracing a circle.
      const r = radius * (1 + Math.sin(k * Math.PI) * 0.14)
      const x = cx + Math.cos(angle) * r
      const y = cy + Math.sin(angle) * r * 0.78
      d += (s === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1)
    }
    path.setAttribute('d', d)
    path.setAttribute('stroke', RIBBON_COLORS[i % RIBBON_COLORS.length])
    path.setAttribute('stroke-width', (5 + seedA * 3).toFixed(1))
    path.setAttribute('opacity', '0.85')
  }
}

/** How present the glyph is right now, 0..1, with eased edges. */
function glyphAmount(spec: GlyphSpec, elapsed: number): number {
  const position = elapsed % spec.period
  const start = spec.period - spec.hold
  if (position < start) return 0
  const into = position - start
  const remaining = spec.hold - into
  const EASE = 200
  return Math.max(0, Math.min(1, Math.min(into, remaining) / EASE))
}

export interface EffectFrame {
  trails: SVGGElement | null
  confetti: SVGGElement | null
  glyph: SVGGElement | null
  bodyContent: SVGGElement | null
  state: CursorState
  elapsed: number
  strength: number
  paint: string
  showEffects: boolean
  showGlyphs: boolean
  showTrails?: boolean
}

/** Called once per frame from the engine loop. */
export function updateEffects(frame: EffectFrame) {
  const spec = EFFECTS[frame.state]
  const centre = FACE_BOX / 2
  const strength = frame.strength

  if (frame.trails) {
    if (spec?.trails && frame.showEffects && frame.showTrails !== false && strength > 0) {
      drawTrails(frame.trails, spec.trails, frame.elapsed, strength, centre, centre)
    } else if (frame.trails.childNodes.length) {
      frame.trails.replaceChildren()
    }
  }

  if (frame.confetti) {
    if (spec?.confetti && frame.showEffects && strength > 0) {
      drawConfetti(frame.confetti, spec.confetti, frame.elapsed, strength, centre, centre)
    } else if (frame.confetti.childNodes.length) {
      frame.confetti.replaceChildren()
    }
  }

  if (frame.glyph && frame.bodyContent) {
    if (spec?.glyph && frame.showGlyphs) {
      const amount = glyphAmount(spec.glyph, frame.elapsed)
      const markup = spec.glyph.markup.replace(/\{\{GRADIENT\}\}/g, frame.paint)
      if (frame.glyph.getAttribute('data-glyph') !== markup) {
        frame.glyph.setAttribute('data-glyph', markup)
        frame.glyph.innerHTML = markup
      }
      frame.glyph.style.opacity = String(amount)
      // Scale up as it arrives, so the swap reads as a transformation.
      const scale = 0.72 + 0.28 * amount
      frame.glyph.setAttribute(
        'transform',
        `translate(${centre} ${centre}) scale(${scale.toFixed(3)}) translate(${-centre} ${-centre})`
      )
      // The body steps aside rather than sitting behind the glyph.
      frame.bodyContent.style.opacity = String(1 - amount)
    } else {
      if (frame.glyph.getAttribute('data-glyph')) {
        frame.glyph.removeAttribute('data-glyph')
        frame.glyph.replaceChildren()
      }
      frame.glyph.style.opacity = '0'
      frame.bodyContent.style.opacity = '1'
    }
  }
}

/* ------------------------------------------------------------------ states */

export type CursorState =
  | "sleeping"
  | "waking"
  | "idle"
  | "listening"
  | "thinking"
  | "searching"
  | "working"
  | "excited"
  | "surprised"
  | "suspicious"
  | "angry"
  | "drowsy"
  | "happy"
  | "curious"
  | "confused"
  | "bored"
  | "proud"
  | "shy"
  | "sad"
  | "laughing"
  | "scared"
  | "playful"
  | "celebrate"
  | "orbit"
  | "radar"
  | "progress"
  | "spawning"
  | "humming"
  | "loading"
  | "dictating"
  | "sending"
  | "receiving"
  | "uploading"
  | "writing"
  | "notifying"
  | "alerting"
  | "bouncing"
  | "dragging"
  | "powering-down"

/**
 * Which expressions a state cycles through. The first is its resting face, chosen as the
 * pool's most forward-facing member so a mascot at rest looks at you rather than past you.
 */
export const POOLS: Record<CursorState, number[]> = Object.fromEntries(Object.entries(LAOA_DATA.pools).map(([key,values]) => [key,[...values]])) as Record<CursorState, number[]>

/** How long a state holds an expression before drifting to another, in ms. */
const EXPR_CADENCE = {
  sleeping: [
    6000,
    10000
  ],
  waking: [
    800,
    800
  ],
  idle: [
    9000,
    16000
  ],
  listening: [
    2800,
    5000
  ],
  thinking: [
    2000,
    3600
  ],
  searching: [
    1000,
    1800
  ],
  working: [
    1800,
    3200
  ],
  excited: [
    1100,
    2000
  ],
  surprised: [
    2500,
    4000
  ],
  suspicious: [
    2600,
    4500
  ],
  angry: [
    2200,
    3800
  ],
  drowsy: [
    4000,
    8000
  ],
  happy: [
    2500,
    4500
  ],
  curious: [
    1800,
    3200
  ],
  confused: [
    2200,
    3800
  ],
  bored: [
    3500,
    6000
  ],
  proud: [
    3500,
    6000
  ],
  shy: [
    3000,
    5500
  ],
  sad: [
    4000,
    7000
  ],
  laughing: [
    1200,
    2400
  ],
  scared: [
    900,
    1800
  ],
  playful: [
    1500,
    3000
  ],
  celebrate: [
    1400,
    2600
  ],
  orbit: [
    4000,
    8000
  ],
  radar: [
    4000,
    8000
  ],
  progress: [
    4000,
    8000
  ],
  spawning: [
    1200,
    1200
  ],
  humming: [
    5000,
    9000
  ],
  loading: [
    6000,
    10000
  ],
  dictating: [
    4000,
    8000
  ],
  sending: [
    4000,
    8000
  ],
  receiving: [
    4000,
    8000
  ],
  uploading: [
    4000,
    8000
  ],
  writing: [
    4000,
    8000
  ],
  notifying: [
    1500,
    2600
  ],
  alerting: [
    2000,
    3600
  ],
  bouncing: [
    3000,
    6000
  ],
  dragging: [
    1600,
    3000
  ],
  "powering-down": [
    6000,
    9000
  ]
} satisfies Record<CursorState, [number, number]>

/** Blink cadence in ms, or null for states that never blink. */
const BLINK = {
  sleeping: null,
  waking: null,
  idle: [
    6000,
    14000
  ],
  listening: [
    3000,
    7000
  ],
  thinking: [
    3500,
    7000
  ],
  searching: [
    1600,
    4000
  ],
  working: [
    2800,
    5500
  ],
  excited: [
    2000,
    4000
  ],
  surprised: [
    1800,
    3500
  ],
  suspicious: [
    4500,
    8000
  ],
  angry: [
    3500,
    7000
  ],
  drowsy: null,
  happy: [
    2500,
    5000
  ],
  curious: [
    2500,
    5500
  ],
  confused: [
    2800,
    5500
  ],
  bored: [
    4000,
    8000
  ],
  proud: [
    3500,
    7000
  ],
  shy: [
    3000,
    6000
  ],
  sad: [
    4000,
    8000
  ],
  laughing: [
    2500,
    5000
  ],
  scared: [
    1200,
    3000
  ],
  playful: [
    2000,
    4500
  ],
  celebrate: [
    2200,
    4500
  ],
  orbit: null,
  radar: null,
  progress: null,
  spawning: null,
  humming: [
    4000,
    8000
  ],
  loading: null,
  dictating: null,
  sending: null,
  receiving: null,
  uploading: null,
  writing: null,
  notifying: [
    2000,
    4000
  ],
  alerting: null,
  bouncing: null,
  dragging: [
    2200,
    4500
  ],
  "powering-down": null
} satisfies Record<CursorState, [number, number] | null>

/** Grouping, for pickers and docs. */
export const STATE_GROUPS = {
  "Cycle de vie": [
    "sleeping",
    "waking",
    "idle",
    "listening",
    "thinking",
    "searching",
    "working"
  ],
  "Réactions": [
    "excited",
    "surprised",
    "suspicious",
    "angry",
    "drowsy",
    "happy",
    "curious",
    "confused",
    "bored",
    "proud",
    "shy",
    "sad",
    "laughing",
    "scared",
    "playful",
    "celebrate"
  ],
  "Morphes agent": [
    "orbit",
    "radar",
    "progress"
  ],
  "Cycle produit": [
    "spawning",
    "humming",
    "loading",
    "dictating",
    "writing",
    "sending",
    "receiving",
    "uploading",
    "notifying",
    "alerting",
    "dragging",
    "bouncing",
    "powering-down"
  ]
} satisfies Record<string, CursorState[]>

const isCursorState = (state: string): state is CursorState => state in POOLS
export const CURSOR_STATES = Object.keys(POOLS).filter(isCursorState)

/* ------------------------------------------------------------------- maths */

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const noTimestamp = (): number | null => null

const toPath = (ring: Ring) =>
  'M' + ring.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z'

const clone = (rings: Ring[]): Ring[] =>
  rings.map(r => r.map((p): [number, number] => [p[0], p[1]]))

/** Ring centroid for eye projection. */
const ringCentre = (ring: Ring): [number, number] => {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p[0]
    y += p[1]
  }
  return [x / ring.length, y / ring.length]
}

/** Face-space transform placing the face inside a silhouette. */
export const anchorTransform = (a: { x: number; y: number; scale: number }) =>
  `translate(${a.x} ${a.y}) scale(${a.scale}) translate(${-FACE_CENTRE[0]} ${-FACE_CENTRE[1]})`

/** Overshooting ease, so a pop-in lands with a little life instead of stopping dead. */
const easeOutBack = (t: number) => {
  const c = 1.7
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t))

/**
 * Builds the body's transform for this frame.
 *
 * `elapsed` is time since the state was entered, which is what one-shot entrances need;
 * loops read it too so every mascot on a page doesn't pulse in lockstep.
 */
export function bodyTransform(motion: BodyMotion, elapsed: number, strength: number): string {
  if (strength <= 0) return ''
  const centre = FACE_BOX / 2
  const ground = FACE_BOX
  const wave = (period: number, phase = 0) => Math.sin((elapsed / period) * Math.PI * 2 + phase)

  let dx = 0
  let dy = 0
  let rotation = motion.tilt ? motion.tilt * strength : 0
  let scale = 1
  let sx = 1
  let sy = 1

  if (motion.bob) {
    const [amplitude, period] = motion.bob
    const p = wave(period)
    dy -= amplitude * strength * p
    if (motion.squash) {
      // Squash at the bottom of the arc, stretch at the top. Volume roughly conserved.
      const amount = motion.squash * strength * Math.max(0, -p)
      sy = 1 - amount * 0.5
      sx = 1 + amount * 0.5
    }
  }
  if (motion.circle) {
    const [radius, period] = motion.circle
    dx += radius * strength * wave(period)
    dy += radius * strength * wave(period, Math.PI / 2)
  }
  if (motion.sway) {
    const [degrees, period] = motion.sway
    rotation += degrees * strength * wave(period)
  }
  if (motion.pulse) {
    const [fraction, period] = motion.pulse
    scale *= 1 + fraction * strength * wave(period)
  }
  if (motion.jitter) {
    const [amplitude, period] = motion.jitter
    // Two incommensurate waves read as nervous rather than metronomic.
    dx += amplitude * strength * wave(period)
    dy += amplitude * strength * wave(period * 0.63, 1.1)
  }
  if (motion.enter) {
    const [from, duration] = motion.enter
    const t = elapsed / duration
    scale *= t >= 1 ? 1 : from + (1 - from) * easeOutBack(Math.max(t, 0))
  }
  if (motion.settle !== undefined) {
    const t = Math.min(Math.max(elapsed / SETTLE_MS, 0), 1)
    scale *= 1 + (motion.settle - 1) * easeInOut(t) * strength
  }

  const parts: string[] = []
  if (dx || dy) parts.push(`translate(${dx.toFixed(2)} ${dy.toFixed(2)})`)
  if (rotation) parts.push(`rotate(${rotation.toFixed(2)} ${centre} ${centre})`)
  if (scale !== 1) {
    parts.push(`translate(${centre} ${centre}) scale(${scale.toFixed(4)}) translate(${-centre} ${-centre})`)
  }
  if (sx !== 1 || sy !== 1) {
    // Squash pivots on the ground, not the middle — otherwise it floats instead of landing.
    parts.push(`translate(${centre} ${ground}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-centre} ${-ground})`)
  }
  return parts.join(' ')
}

/* --------------------------------------------------------------- component */


export interface CursorOptions {
  state: CursorState
  paused: boolean
  color: string
  silhouette: CursorSilhouette
  gaze?: { x?: number; y?: number }
  expression?: number
  fixedTime?: number
  /** Live activity rings. A saved "working" face does not wear them. */
  ribbons?: boolean
  /** Draw activity around an uploaded avatar without drawing a replacement face. */
  effectsOnly?: boolean
}
type Engine = ReturnType<typeof newEngine>
function newEngine() {
  return { current: clone(EXPRESSIONS[0]), target: EXPRESSIONS[0], expression: 0, morph: 1, velocity: 0, blinkStart: noTimestamp(), spinStart: noTimestamp(), spinDuration: 900, last: 0, stateStart: 0, lastState: 'idle' as CursorState, lastBodyTransform: '',
    props: {state: 'idle' as CursorState, expression: undefined as number | undefined, gaze: undefined as {x?:number;y?:number}|undefined, turn:0, spring:7, eyeScale:1, paused:true, motionStrength:0, effects:true, glyphs:true, ribbons:true} }
}
let nextId = 0
export function mountCursorAvatar(svg: SVGSVGElement, initial: CursorOptions) {
  const uid = `maus-${++nextId}`
  const engine = { current: newEngine() }
  const paintRef = { current: initial.color }
  const node = <T extends Element>(id: string) => ({ current: svg.querySelector<T>(`[data-part="${id}"]`)! })
  svg.setAttribute('viewBox', VIEW_BOX)
  svg.innerHTML = `<defs><clipPath id="${uid}-clip" data-part="clip" /></defs><g data-part="trails"/><g data-part="bodyGroup"><g data-part="bodyContent"><g data-part="outline"/><g clip-path="url(#${uid}-clip)"><g data-part="face"><path data-part="eye0" fill="white"/><path data-part="eye1" fill="white"/></g></g></g><g data-part="glyph" opacity="0"/></g><g data-part="confetti"/>`
  const eye0=node<SVGPathElement>('eye0'), eye1=node<SVGPathElement>('eye1')
  const bodyGroup=node<SVGGElement>('bodyGroup'), bodyContent=node<SVGGElement>('bodyContent'), trailLayer=node<SVGGElement>('trails'), confettiLayer=node<SVGGElement>('confetti'), glyphLayer=node<SVGGElement>('glyph')
  const selectExpression = (index:number, immediate = false) => {
    const e=engine.current, i=((index % EXPRESSION_COUNT)+EXPRESSION_COUNT)%EXPRESSION_COUNT
    if (i === e.expression && e.morph >= 1 && !immediate) return
    e.current=displayed(e)
    e.target=EXPRESSIONS[i];e.expression=i;e.morph=immediate?1:0;e.velocity=0
  }
      const draw = (e: Engine, now: number, spinTurn: number) => {
        const p = e.props
        const rings = displayed(e)
        const gx = clamp(p.gaze?.x ?? 0, -1, 1) * GAZE_TRAVEL.x
        const gy = clamp(p.gaze?.y ?? 0, -1, 1) * GAZE_TRAVEL.y
        const radians = (((p.turn ?? 0) + spinTurn) * Math.PI) / 180
        const base = p.eyeScale ?? 1
        const blink = blinkScale(e, now)

        rings.forEach((ring, index) => {
          const el = index === 0 ? eye0.current : eye1.current
          if (!el) return
          const c = ringCentre(ring)
          const baseLongitude = Math.asin(clamp((c[0] - SPHERE_C) / SPHERE_R, -1, 1))
          const longitude = baseLongitude + radians
          const depth = Math.cos(longitude)
          const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02)
          el.setAttribute('d', toPath(ring))
          el.setAttribute(
            'transform',
            `translate(${(SPHERE_C + SPHERE_R * Math.sin(longitude) + gx).toFixed(2)} ${(
              c[1] + gy
            ).toFixed(2)}) scale(${clamp(perspective * base, 0.02, 2.4).toFixed(4)} ${clamp(
              blink * base,
              0.02,
              2.4
            ).toFixed(4)}) translate(${(-c[0]).toFixed(2)} ${(-c[1]).toFixed(2)})`
          )
          el.style.opacity = depth > 0.02 ? '1' : '0'
        })

        // The body. One-shot entrances need time since the state began, so track that here
        // rather than in an effect — the loop already has the clock.
        const bodyEl = bodyGroup.current
        if (bodyEl) {
          if (p.state !== e.lastState) {
            e.lastState = p.state
            e.stateStart = now
          }
          const transform = bodyTransform(
            MOTION[p.state] ?? {},
            now - e.stateStart,
            p.motionStrength ?? 1
          )
          if (transform !== e.lastBodyTransform) {
            e.lastBodyTransform = transform
            if (transform) bodyEl.setAttribute('transform', transform)
            else bodyEl.removeAttribute('transform')
          }
        }

        updateEffects({
          trails: trailLayer.current,
          confetti: confettiLayer.current,
          glyph: glyphLayer.current,
          bodyContent: bodyContent.current,
          state: p.state,
          elapsed: now - e.stateStart,
          strength: p.motionStrength ?? 1,
          paint: paintRef.current,
          showEffects: p.effects !== false,
          showGlyphs: p.glyphs !== false,
          showTrails: p.ribbons !== false,
        })
      }


  let options=initial, frame=0, blinkTimer: ReturnType<typeof setTimeout>|undefined, expressionTimer:ReturnType<typeof setTimeout>|undefined, disposed=false
  function stop() { cancelAnimationFrame(frame);frame=0;clearTimeout(blinkTimer);clearTimeout(expressionTimer) }
  function armBlink() {
    const range=BLINK[options.state]
    if(options.paused||options.fixedTime!==undefined||!range)return
    blinkTimer=setTimeout(()=>{engine.current.blinkStart=performance.now();armBlink()},range[0]+Math.random()*(range[1]-range[0]))
  }
  function armExpression() {
    if(options.paused||options.fixedTime!==undefined||options.expression!==undefined)return
    const [lo,hi]=EXPR_CADENCE[options.state]
    expressionTimer=setTimeout(()=>{const pool=POOLS[options.state].filter(i=>i!==engine.current.expression);selectExpression(pool.length?pool[Math.floor(Math.random()*pool.length)]:POOLS[options.state][0]);armExpression()},lo+Math.random()*(hi-lo))
  }
  function step(now:number) {
    frame=0
    if(disposed||options.paused||options.fixedTime!==undefined)return
    const e=engine.current, dt=Math.min((now-e.last)/1000,.1);e.last=now
    e.velocity+=(-14*e.velocity-49*(e.morph-1))*dt;e.morph+=e.velocity*dt
    if(!Number.isFinite(e.morph)){e.morph=1;e.velocity=0}
    draw(e,now,0);frame=requestAnimationFrame(step)
  }
  let lastBody = '', lastClip = ''
  function update(next:CursorOptions) {
    const changed=options.state!==next.state||options.expression!==next.expression
    const resume=options.paused!==next.paused||options.fixedTime!==next.fixedTime
    options=next
    svg.setAttribute('viewBox', next.silhouette.viewBox ?? VIEW_BOX)
    const e=engine.current, now=performance.now();paintRef.current=next.color
    e.props={...e.props,state:next.state,expression:next.expression,gaze:next.gaze,paused:next.paused,motionStrength:next.paused?0:1,ribbons:next.ribbons!==false}
    const [vx,vy,vw,vh] = (next.silhouette.viewBox ?? VIEW_BOX).split(/\s+/).map(Number)
    const cx = vx + vw / 2, cy = vy + vh / 2
    const hasTrails = !next.paused && next.ribbons !== false && !!EFFECTS[next.state]?.trails
    bodyGroup.current.style.visibility = next.effectsOnly ? 'hidden' : ''
    // Leave room for live ribbons while keeping the saved silhouette and resting size.
    bodyContent.current.setAttribute('transform', hasTrails ? `translate(${cx} ${cy}) scale(.72) translate(${-cx} ${-cy})` : '')
    trailLayer.current.setAttribute('transform', `translate(${cx} ${cy}) scale(${Math.min(vw,vh) / FACE_BOX}) translate(${-FACE_BOX / 2} ${-FACE_BOX / 2})`)
    const outline=node<SVGGElement>('outline').current, clip=node<SVGClipPathElement>('clip').current, face=node<SVGGElement>('face').current
    const body=next.silhouette.body.replace(/\{\{GRADIENT\}\}/g,next.color)
    if(lastBody!==body){outline.innerHTML=body;lastBody=body}
    if(lastClip!==next.silhouette.clip){clip.innerHTML=next.silhouette.clip;lastClip=next.silhouette.clip}
    outline.setAttribute('transform',next.silhouette.fit||'');clip.setAttribute('transform',next.silhouette.fit||'');face.setAttribute('transform',anchorTransform(next.silhouette.anchor))
    if(changed||next.paused||e.last===0)selectExpression(next.expression??POOLS[next.state][0],next.paused||e.last===0)
    if(changed||e.last===0){e.stateStart=now;e.lastState=next.state}
    e.last=now
    if(changed||resume||!frame){stop();armBlink();armExpression()}
    draw(e,next.paused ? e.stateStart+(next.fixedTime??0) : next.fixedTime===undefined?now:e.stateStart+next.fixedTime,0)
    if(!next.paused&&next.fixedTime===undefined&&!frame)frame=requestAnimationFrame(step)
  }
  update(initial)
  return {update,dispose(){disposed=true;stop();svg.replaceChildren()}}
}
function displayed(e: { current: Ring[]; target: Ring[]; morph: number }): Ring[] {
  const m = clamp(e.morph, 0, 1)
  return e.current.map((ring, eye) =>
    ring.map((p, i): [number, number] => [
      p[0] + (e.target[eye][i][0] - p[0]) * m,
      p[1] + (e.target[eye][i][1] - p[1]) * m,
    ])
  )
}

function blinkScale(e: { blinkStart: number | null }, now: number) {
  if (e.blinkStart === null) return 1
  const t = (now - e.blinkStart) / 320
  if (t >= 1) {
    e.blinkStart = null
    return 1
  }
  // Fast close, slower open.
  return Math.max(t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58, 0.04)
}
