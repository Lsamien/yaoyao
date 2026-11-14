import {fileURLToPath} from 'node:url'
import {dirname} from 'node:path'
import {prepareKernel} from '../bin/lib/kernel-setup.mjs'
import {isNpmInstallation} from '../bin/lib/npm-release.mjs'

const root=dirname(dirname(fileURLToPath(import.meta.url)))
// Source checkouts keep the explicit `npm run kernel:setup`; npm installs prepare on postinstall.
if(!process.argv.includes('--postinstall')||isNpmInstallation(root)){
  try{await prepareKernel({root,force:process.argv.includes('--force')})}
  catch(error){console.error(error.message);process.exitCode=1}
}
