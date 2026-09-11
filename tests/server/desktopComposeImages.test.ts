// @vitest-environment node
import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
// @ts-expect-error Deployment generator is a standalone Node script.
import {generateDesktopCompose} from '../../scripts/generate-desktop-compose.mjs'
import {parseComposeDesktops} from '../../src/server/composeDesktops'
const base=readFileSync(new URL('../../compose.yaml',import.meta.url),'utf8')
const entries=JSON.parse(readFileSync(new URL('../../deploy/compose-desktops.json',import.meta.url),'utf8'))
it('generates different recipes and isolated persistent volumes for two fixed desktops',()=>{
 const yaml=generateDesktopCompose(base,[entries[0],{...entries[1],imageKey:'cursor'}])
 expect(yaml).toContain('dockerfile: Dockerfile\n')
 expect(yaml).toContain('dockerfile: Dockerfile.cursor\n')
 expect(yaml).toContain('platform: linux/amd64')
 expect(yaml).toContain('YAOYAO_CURSOR_DESKTOP_IMAGE:-yaoyao-desktop:cursor')
 expect(yaml).toContain('desktop-1-workspace:/home/cua/workspace')
 expect(yaml).toContain('desktop-2-workspace:/home/cua/workspace')
 expect(yaml).not.toContain('/var/run/docker.sock')
 const line=yaml.split('\n').find((s:string)=>s.includes('HERMES_YAOYAO_COMPOSE_DESKTOPS:'))!
 const targets=parseComposeDesktops(JSON.parse(line.slice(line.indexOf(':')+1).trim()))
 expect(targets.map(d=>d.imageKey)).toEqual(['standard','cursor'])
 expect(targets[0]?.socketPath).not.toBe(targets[1]?.socketPath)
 for(const key of ['arbitrary','__proto__','constructor','cursor\n    privileged: true'])expect(()=>generateDesktopCompose(base,[{...entries[0],imageKey:key}])).toThrow()
})
