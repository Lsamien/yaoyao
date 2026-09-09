import {mkdir,copyFile,cp} from 'node:fs/promises'
import {resolve} from 'node:path'
const directory=resolve(import.meta.dirname,'../dist-server/runner/worker')
await mkdir(directory,{recursive:true})
await copyFile(resolve(import.meta.dirname,'../src/runner/worker/hermes_worker.py'),resolve(directory,'hermes_worker.py'))

await copyFile(resolve(import.meta.dirname,'../src/runner/network/guest_proxy.py'),resolve(directory,'guest_proxy.py'))

await cp(resolve(import.meta.dirname,'../deploy/computer'),resolve(directory,'../computers/computer-image'),{recursive:true})

await cp(resolve(import.meta.dirname,'../third-party'),resolve(directory,'../computers/third-party'),{recursive:true})
