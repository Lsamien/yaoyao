export function kernelVenv(root: string, env?: NodeJS.ProcessEnv): string
export function kernelPython(root: string, env?: NodeJS.ProcessEnv): string
export function verifyKernel(options: { root: string; env?: NodeJS.ProcessEnv; python?: string }): string
export function prepareKernel(options: { root: string; env?: NodeJS.ProcessEnv; force?: boolean }): Promise<string>
