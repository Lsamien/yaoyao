import {mkdir,copyFile,cp} from 'node:fs/promises'
import {resolve} from 'node:path'
const directory=resolve(import.meta.dirname,'../dist-server/runner/worker')
await mkdir(directory,{recursive:true})
await cp(resolve(import.meta.dirname,'../integrations/hermes-bots-bridge'),resolve(directory,'../hermes-bots-bridge'),{recursive:true,filter:source=>!source.includes('__pycache__')&&!source.endsWith('.pyc')&&!source.includes('/tests')})
await copyFile(resolve(import.meta.dirname,'install-hermes-bridge.py'),resolve(directory,'../install-hermes-bridge.py'))
await copyFile(resolve(import.meta.dirname,'../src/runner/worker/hermes_worker.py'),resolve(directory,'hermes_worker.py'))
await copyFile(resolve(import.meta.dirname,'../src/runner/worker/profile_skills.py'),resolve(directory,'profile_skills.py'))
await copyFile(resolve(import.meta.dirname,'../deploy/computer/skill_bundle.py'),resolve(directory,'skill_bundle.py'))

await copyFile(resolve(import.meta.dirname,'../src/runner/network/guest_proxy.py'),resolve(directory,'guest_proxy.py'))

await cp(resolve(import.meta.dirname,'../deploy/computer'),resolve(directory,'../computers/computer-image'),{recursive:true})

await cp(resolve(import.meta.dirname,'../third-party'),resolve(directory,'../computers/third-party'),{recursive:true})
