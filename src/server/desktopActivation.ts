import { grantDesktopActivation, hasDesktopActivation } from '../../bin/lib/desktop-activation.mjs'

/** A successful entry authorizes independent background restarts. A desktop
 * check clears that grant only immediately before it starts a new service. */
export class DesktopActivation {
  private activated: boolean
  private started = false
  constructor(private readonly home: string, deferred: boolean, private readonly launch: () => void) {
    this.activated = !deferred || hasDesktopActivation(home)
  }
  get required() { return !this.activated }
  start() {
    if (!this.activated || this.started) return
    this.launch()
    this.started = true
  }
  activate() {
    grantDesktopActivation(this.home)
    this.activated = true
    this.start()
  }
}
