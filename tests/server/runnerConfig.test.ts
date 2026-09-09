// @vitest-environment node
import {expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {parseRunnerConfiguration} from '../../src/runner/config'
const config={protocol:1,runnerId:randomUUID(),token:'secret-fixture-'.repeat(3),serverURL:'https://example.invalid',hermesURL:'http://127.0.0.1:9119',allowedProfiles:['default'],artifactRoots:[]}
it.each([
  {serverURL:'http://example.invalid'},
  {serverURL:'https://user:password@example.invalid'},
  {serverURL:'https://example.invalid/path'},
  {hermesURL:'http://host.docker.internal:9119'},
  {hermesURL:'http://user:password@127.0.0.1:9119'},
  {artifactRoots:['relative/path']},
  {allowedProfiles:['../default']},
  {protocol:2},
  {command:'/bin/sh'},
])('rejects invalid or expanded node configuration without echoing credentials (%j)',patch=>{
  expect(()=>parseRunnerConfiguration({...config,...patch})).toThrow()
  try{parseRunnerConfiguration({...config,...patch})}catch(error){expect(String(error)).not.toContain(config.token);expect(String(error)).not.toContain('password')}
})
it('accepts explicit LAN opt-in and keeps service credentials in the private configuration',()=>{
  expect(parseRunnerConfiguration({...config,serverURL:'http://192.168.1.2:15300',allowInsecureLan:true,hermesCredentials:{username:'fixture',password:'private'}})).toMatchObject({allowInsecureLan:true,hermesCredentials:{username:'fixture',password:'private'}})
})

it('keeps existing computer configurations offline unless public access is explicitly enabled',()=>{
  const computers={runtime:'docker',imageId:'sha256:'+ 'a'.repeat(64),python:'/fixture/python',hermesSource:'/fixture/source',hermesHome:'/fixture/home'}
  expect(parseRunnerConfiguration({...config,computers}).computers?.network).toBe('none')
  expect(parseRunnerConfiguration({...config,computers:{...computers,network:'public-proxy'}}).computers?.network).toBe('public-proxy')
  expect(()=>parseRunnerConfiguration({...config,computers:{...computers,network:'host'}})).toThrow()
})
it('resolves optional Hermes paths on the execution host while preserving explicit installation paths',()=>{
 const computers={runtime:'docker',imageId:'sha256:'+'0'.repeat(64)}
 expect(parseRunnerConfiguration({...config,computers}).computers).toMatchObject({hermesHome:join(homedir(),'.hermes'),hermesSource:join(homedir(),'.hermes','hermes-agent'),python:join(homedir(),'.hermes','hermes-agent','venv','bin','python')})
 expect(parseRunnerConfiguration({...config,computers:{...computers,hermesHome:'/custom/hermes',hermesSource:'/custom/source',python:''}}).computers?.python).toBe('/custom/source/venv/bin/python')
 expect(()=>parseRunnerConfiguration({...config,computers:{...computers,hermesHome:'relative'}})).toThrow()
})
