import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sourceBuild } from '../bin/lib/runtime-release.mjs'
const root = resolve(import.meta.dirname, '..')
writeFileSync(resolve(root, 'build-info.json'), JSON.stringify({ ...sourceBuild(root), builtAt: new Date().toISOString() }, null, 2) + '\n')
