import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(import.meta.dirname,'..')
const recipes={
  standard:{image:'${YAOYAO_DESKTOP_IMAGE:-hermes-yaoyao-desktop:0.4.0}',dockerfile:'Dockerfile'},
  cursor:{image:'${YAOYAO_CURSOR_DESKTOP_IMAGE:-yaoyao-desktop:cursor}',dockerfile:'Dockerfile.cursor',platform:'linux/amd64'},
}
export function generateDesktopCompose(base,entries,source='deploy/compose-desktops.json'){
  if(!Array.isArray(entries)||entries.length<1||entries.length>32)throw new Error('Compose 桌面数量须为 1–32')
  for(const d of entries){
    if(!d||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(d.id)||!/^desktop-[a-z0-9-]+$/.test(d.service)||typeof d.name!=='string'||!d.name.trim())throw new Error('Compose 桌面定义无效')
    if(d.imageKey!==undefined&&!Object.hasOwn(recipes,d.imageKey))throw new Error('桌面镜像须为 standard 或 cursor')
  }
  if(new Set(entries.map(d=>d.id)).size!==entries.length||new Set(entries.map(d=>d.service)).size!==entries.length)throw new Error('Compose 桌面定义重复')
  const q=JSON.stringify
  const targets=entries.map(d=>({id:d.id,name:d.name,socketPath:`/run/yaoyao-desktops/${d.service}/desktop.sock`,imageKey:d.imageKey??'standard'}))
  base=base.replace('      HERMES_YAOYAO_LOCAL_VM_HOST: "runner"','      HERMES_YAOYAO_LOCAL_VM_HOST: "runner"\n      HERMES_YAOYAO_COMPOSE_DESKTOPS: '+q(JSON.stringify(targets)))
    .replace('      - yaoyao-data:/home/node/.yaoyao','      - yaoyao-data:/home/node/.yaoyao\n'+entries.map(d=>`      - ${d.service}-ipc:/run/yaoyao-desktops/${d.service}:ro`).join('\n'))
  const volumesAt=base.indexOf('\nvolumes:')
  if(volumesAt<0||!base.includes('HERMES_YAOYAO_COMPOSE_DESKTOPS'))throw new Error('compose.yaml 模板结构已变化')
  let yaml=`# Generated from compose.yaml and ${source}.\n`+base.slice(0,volumesAt)+'\n'
  for(const d of entries){
    const recipe=recipes[d.imageKey??'standard']
    yaml+=`  ${d.service}:
    image: "${recipe.image}"
${recipe.platform?`    platform: ${recipe.platform}\n`:''}    build:
      context: ./deploy/computer
      dockerfile: ${recipe.dockerfile}
    hostname: ${d.service}
    extra_hosts:
      - "${d.service}:127.0.0.1"
    init: true
    restart: unless-stopped
    network_mode: none
    shm_size: 512m
    mem_limit: 4g
    cpus: 2
    pids_limit: 512
    cap_drop:
      - ALL
    cap_add:
      - SETUID
      - SETGID
      - CHOWN
      - KILL
    environment:
      YAOYAO_COMPOSE_DESKTOP_ID: ${q(d.id)}
    volumes:
      - ${d.service}-workspace:/home/cua/workspace
      - ${d.service}-ipc:/run/yaoyao-private/bridge
`
  }
  yaml+=base.slice(volumesAt)+'\n'
  for(const d of entries)yaml+=`  ${d.service}-workspace:\n  ${d.service}-ipc:\n`
  return yaml
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const base=readFileSync(resolve(root,'compose.yaml'),'utf8')
  for(const suffix of ['', '.cursor']){
    const source=`deploy/compose-desktops${suffix}.json`
    const entries=JSON.parse(readFileSync(resolve(root,source),'utf8'))
    const yaml=generateDesktopCompose(base,entries,source)
    const name=`compose.desktops${suffix}.yaml`,output=resolve(root,name)
    if(process.argv.includes('--check')){if(readFileSync(output,'utf8')!==yaml)throw new Error(`${name} 与桌面定义不同步，请运行 node scripts/generate-desktop-compose.mjs`)}
    else writeFileSync(output,yaml)
    console.log(`${name}：${entries.length} 台共享桌面`)
  }
}
