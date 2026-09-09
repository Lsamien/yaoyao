#!/usr/bin/env node
// Canonical data is vendored: generation and builds never need the source checkout.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = JSON.parse(readFileSync(resolve(root, 'assets/mascot/laoa-source.json'), 'utf8'))
const check = process.argv.includes('--check')
const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : resolve(process.argv[i + 1]) }
const ios = option('--ios'), android = option('--android')
const number = n => Number(n.toFixed(6))

// Convert the source's absolute SVG commands into M/C/Z once. This is also the
// input accepted by the native CGPath parser; no per-frame SVG parsing is needed.
function geometry(path, fit = '') {
  const tokens = path.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)
  const translate = fit.match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/), scale = fit.match(/scale\(([-\d.]+)\)/)
  const k = scale ? Number(scale[1]) : 1, tx = translate ? Number(translate[1]) : 0, ty = translate ? Number(translate[2]) : 0
  const at = (x, y) => [number(x * k + tx), number(y * k + ty)]
  let i = 0, command, x = 0, y = 0, start = [0, 0]
  const out = [], xs = [], ys = []
  const read = () => Number(tokens[i++])
  const include = p => { xs.push(p[0]); ys.push(p[1]) }
  function cubic(a, b, c, d) {
    const points = [a, b, c, d].map(p => at(...p))
    include(points[0]); include(points[3])
    for (let axis = 0; axis < 2; axis++) {
      const [p, q, r, s] = points.map(v => v[axis])
      const aa = -p + 3*q - 3*r + s, bb = 2*(p - 2*q + r), cc = q-p
      const disc = bb*bb - 4*aa*cc
      const roots = Math.abs(aa) < 1e-12 ? (Math.abs(bb) < 1e-12 ? [] : [-cc/bb]) : disc < 0 ? [] : [(-bb+Math.sqrt(disc))/(2*aa),(-bb-Math.sqrt(disc))/(2*aa)]
      for (const t of roots.filter(t => t > 0 && t < 1)) {
        const v = (1-t)**3*p + 3*(1-t)**2*t*q + 3*(1-t)*t*t*r + t**3*s
        ;(axis === 0 ? xs : ys).push(v)
      }
    }
    out.push('C' + points.slice(1).flat().join(' '))
  }
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) command = tokens[i++]
    const a = [x,y]
    if (command === 'M') { x=read(); y=read(); start=[x,y]; out.push('M'+at(x,y).join(' ')); include(at(x,y)); command='L' }
    else if (command === 'C') { const b=[read(),read()],c=[read(),read()];x=read();y=read();cubic(a,b,c,[x,y]) }
    else if (command === 'Q') { const b=[read(),read()];x=read();y=read();cubic(a,[a[0]+2/3*(b[0]-a[0]),a[1]+2/3*(b[1]-a[1])],[x+2/3*(b[0]-x),y+2/3*(b[1]-y)],[x,y]) }
    else if (['L','H','V'].includes(command)) { if(command!=='V')x=read();if(command!=='H')y=read();cubic(a,a,[x,y],[x,y]) }
    else if (command === 'Z') { out.push('Z');[x,y]=start;command=undefined }
    else throw new Error('Unsupported path command: '+command)
  }
  const bounds = [Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)].map(number)
  const side = Math.max(bounds[2],bounds[3])
  const viewport = [bounds[0]+(bounds[2]-side)/2,bounds[1]+(bounds[3]-side)/2,side,side].map(number)
  return {path:out.join(' '),bounds,viewport}
}
const aliases = {circle:'blob',square:'squircle',triangle:'triangle',capsule:'capsule',hexagon:'hex',cloud:'cloud',droplet:'drop'}
const shapes = Object.fromEntries(Object.entries(aliases).map(([id, key]) => [id, {...geometry(source.shapes[key].path), anchor:[120,122.5,1]}]))
// Retain the saved ellipse's aspect ratio. Cubic approximation is shared by all clients.
shapes.ellipse = {...geometry('M222.2705 114.2705 C222.2705 162.87156 173.91726 202.2705 114.2705 202.2705 C54.62374 202.2705 6.2705 162.87156 6.2705 114.2705 C6.2705 65.66944 54.62374 26.2705 114.2705 26.2705 C173.91726 26.2705 222.2705 65.66944 222.2705 114.2705 Z'),anchor:[120,122.5,1]}
const bodies = Object.fromEntries(Object.entries(source.legacyBodies).map(([id,b]) => [id, {...geometry(b.path,b.fit),anchor:[b.anchor.x,b.anchor.y,b.anchor.scale]}]))
// Fit the complete expression catalog inside narrow silhouettes. Keep the original
// look direction; solve a single per-shape scale rather than moving each expression.
function safeAnchor(g, anchor) {
  const tokens = g.path.match(/[MCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)
  const edges = []; let i=0, p=[0,0], start=p
  const point = () => [Number(tokens[i++]),Number(tokens[i++])]
  const edge = q => { if(p[1]!==q[1])edges.push([p,q]);p=q }
  while(i<tokens.length) {
    const command=tokens[i++]
    if(command==='M') {p=point();start=p}
    else if(command==='Z')edge(start)
    else if(command==='C') {
      const a=p,b=point(),c=point(),d=point()
      for(let n=1;n<=16;n++){const t=n/16,u=1-t;edge([0,1].map(k=>u**3*a[k]+3*u*u*t*b[k]+3*u*t*t*c[k]+t**3*d[k]))}
    }
  }
  const inside = (x,y) => { let result=false; for(const [a,b] of edges)if((a[1]>y)!==(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])result=!result; return result }
  const points=source.expressions.flat(2)
  const fits = scale => points.every(p=>{const x=anchor[0]+(p[0]-120)*scale,y=anchor[1]+(p[1]-122.5)*scale;return inside(x-1,y)&&inside(x+1,y)&&inside(x,y-1)&&inside(x,y+1)})
  let lo=0,hi=anchor[2]
  if(fits(hi))return anchor
  for(let n=0;n<18;n++){const mid=(lo+hi)/2;if(fits(mid))lo=mid;else hi=mid}
  return [anchor[0],anchor[1],number(lo)]
}
const centers={triangle:[114.2705,135,1],cloud:[114.2705,125,1],droplet:[114.2705,140,1]}
for(const [id,g] of Object.entries(shapes))g.anchor=safeAnchor(g,centers[id]??g.anchor)
for(const g of Object.values(bodies))g.anchor=safeAnchor(g,g.anchor)
const pools = {...source.pools, 'thinking-dots':source.pools.thinking}
const data = {source:source.source,faceBox:source.faceBox,shapes,bodies,expressions:source.expressions,pools}
const banner = '// Generated by hermes-yaoyao/scripts/generate-laoa-avatars.mjs. Do not hand-edit.\n// LaoA-GrokBot '+source.source.commit+' (MIT); legacy bodies OpenMausBot (Apache-2.0).\n'
function write(path,text) { if(check) {if(readFileSync(path,'utf8')!==text)throw new Error('Generated file differs: '+path)}else{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text)} }
write(resolve(root,'src/client/components/common/maus/laoa-data.ts'),banner+'export const LAOA_DATA = '+JSON.stringify(data)+' as const\n')
if (ios) {
  const record = b => 'Geometry(path: "'+b.path+'", viewport: CGRect(x: '+b.viewport[0]+', y: '+b.viewport[1]+', width: '+b.viewport[2]+', height: '+b.viewport[3]+'), anchor: ('+b.anchor.join(', ')+'))'
  const rows = Object.entries({...Object.fromEntries(Object.entries(shapes).map(([k,v])=>['shape:'+k,v])),...Object.fromEntries(Object.entries(bodies).map(([k,v])=>['body:'+k,v]))}).map(([k,v])=>'        "'+k+'": '+record(v)).join(',\n')
  const names = {'powering-down':'poweringDown','thinking-dots':'thinkingDots'}
  write(resolve(ios,'YaoYaoAI/Features/Bots/OpenMaus/LaoAMascotData.swift'),banner+`import CoreGraphics
enum LaoAMascotData {
    struct Geometry { let path: String; let viewport: CGRect; let anchor: (x: CGFloat, y: CGFloat, scale: CGFloat) }
    static let geometries: [String: Geometry] = [
${rows}
    ]
    static func geometry(shape: String, bodyId: String?) -> Geometry {
        if let bodyId, let body = geometries["body:" + bodyId] { return body }
        return geometries["shape:" + (shape == "oval" ? "ellipse" : shape)] ?? geometries["shape:circle"]!
    }
    static let expressions: [CGFloat] = [
${source.expressions.flat(3).reduce((a,v,i)=>{if(i%24===0)a.push('        ');a[a.length-1]+=v+', ';return a},[]).map(line => line.trimEnd()).join('\n')}
    ]
    static let pools: [MausState: [Int]] = [
${Object.entries(pools).map(([k,v])=>'        .'+(names[k]??k)+': ['+v.join(', ')+']').join(',\n')}
    ]
}
`)
}
if(android)write(resolve(android,'core/ui/src/main/res/raw/laoa_mascot.json'),JSON.stringify(data)+'\n')
console.log(`${check?'Verified':'Generated'} ${Object.keys(shapes).length} shapes, ${Object.keys(bodies).length} bodies, ${source.expressions.length} expressions`)
