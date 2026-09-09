import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BuildIdentity { commit: string; buildNumber: number; dirty: boolean; artifactDigest?: string }
export function readBuildIdentity(root: string): BuildIdentity | undefined {
  try {
    const build = JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8'))
    if (typeof build.commit !== 'string' || !Number.isSafeInteger(build.buildNumber)) return undefined
    let artifactDigest: string | undefined
    try { artifactDigest = JSON.parse(readFileSync(join(root, 'runtime-manifest.json'), 'utf8')).artifactDigest } catch { /* Source deployment. */ }
    return { commit: build.commit, buildNumber: build.buildNumber, dirty: build.dirty === true, artifactDigest }
  } catch { return undefined }
}
