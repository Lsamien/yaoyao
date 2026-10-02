export interface NpmRelease { version: string; integrity: string; tarball: string }
export interface PreparedNpmUpdate { archive: string }
export const NPM_PACKAGE: string
export const NPM_RELEASE_SOURCE: string
export function isNpmInstallation(root: string): boolean
export function parseNpmRelease(value: unknown): NpmRelease
export function inspectNpmRelease(cwd: string): Promise<NpmRelease>
export function npmInstallationLocation(root: string): { prefix: string; global: boolean }
export function verifyPreparedNpmArchive(home: string, prepared: PreparedNpmUpdate, npm: NpmRelease): string
export function npmRuntimeDigest(root: string, version: string): string
