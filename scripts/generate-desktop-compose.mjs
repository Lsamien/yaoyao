import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
const root=resolve(import.meta.dirname,'..')
const entries=JSON.parse(readFileSync(resolve(root,'deploy/compose-desktops.json'),'utf8'))
if(!Array.isArray(entries)||entries.length<1||entries.length>32)throw new Error('Compose 桌面数量须为 1–32')
for(const d of entries)if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(d.id)||!/^desktop-[a-z0-9-]+$/.test(d.service)||typeof d.name!=='string'||!d.name.trim())throw new Error('Compose 桌面定义无效')
if(new Set(entries.map(d=>d.id)).size!==entries.length||new Set(entries.map(d=>d.service)).size!==entries.length)throw new Error('Compose 桌面定义重复')
const q=JSON.stringify
const targets=entries.map(d=>({id:d.id,name:d.name,socketPath:`/run/yaoyao-desktops/${d.service}/desktop.sock`}))
const base=readFileSync(resolve(root,'compose.yaml'),'utf8')
  .replace('      HERMES_YAOYAO_LOCAL_VM_HOST: "runner"','      HERMES_YAOYAO_LOCAL_VM_HOST: "runner"\n      HERMES_YAOYAO_COMPOSE_DESKTOPS: '+q(JSON.stringify(targets)))
  .replace('      - yaoyao-data:/home/node/.yaoyao','      - yaoyao-data:/home/node/.yaoyao\n'+entries.map(d=>`      - ${d.service}-ipc:/run/yaoyao-desktops/${d.service}:ro`).join('\n'))
const volumesAt=base.indexOf('\nvolumes:')
if(volumesAt<0||!base.includes('HERMES_YAOYAO_COMPOSE_DESKTOPS'))throw new Error('compose.yaml 模板结构已变化')
let yaml='# Generated from compose.yaml and deploy/compose-desktops.json.\n'+base.slice(0,volumesAt)+'\n'
for(const d of entries)yaml+=`  ${d.service}:\n    image: "\${YAOYAO_DESKTOP_IMAGE:-hermes-yaoyao-desktop:0.4.0}"\n    build:\n      context: ./deploy/computer\n    hostname: ${d.service}\n    extra_hosts:\n      - "${d.service}:127.0.0.1"\n    init: true\n    restart: unless-stopped\n    network_mode: none\n    shm_size: 512m\n    mem_limit: 4g\n    cpus: 2\n    pids_limit: 512\n    security_opt:\n      - no-new-privileges:true\n    cap_drop:\n      - ALL\n    cap_add:\n      - SETUID\n      - SETGID\n      - CHOWN\n      - KILL\n    environment:\n      YAOYAO_COMPOSE_DESKTOP_ID: ${q(d.id)}\n    volumes:\n      - ${d.service}-workspace:/home/cua/workspace\n      - ${d.service}-ipc:/run/yaoyao-private/bridge\n`
yaml+=base.slice(volumesAt)+'\n'
for(const d of entries)yaml+=`  ${d.service}-workspace:\n  ${d.service}-ipc:\n`
const output=resolve(root,'compose.desktops.yaml')
if(process.argv.includes('--check')){if(readFileSync(output,'utf8')!==yaml)throw new Error('compose.desktops.yaml 与桌面定义不同步，请运行 node scripts/generate-desktop-compose.mjs')}
else writeFileSync(output,yaml)
console.log(`Compose 共享桌面：${entries.length} 台`)
