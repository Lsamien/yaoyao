/**
 * Address of the user Web (15300). Computers and execution nodes connect to it, never to the
 * admin console, so the console sets this from its session before showing registration forms.
 */
let override: string | undefined

export function setWebOrigin(origin: string | undefined): void {
  override = origin
}

export function webOrigin(): string {
  return override ?? window.location.origin
}
