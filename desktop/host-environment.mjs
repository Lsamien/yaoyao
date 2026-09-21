import {arch,release} from 'node:os'
import {HOST_SHELL} from './host-files.mjs'

/** Optional metadata stays off the wire until the server advertises support. */
export class HostEnvironmentReporter {
 constructor(home){this.home=home;this.supported=false}
 accept(capabilities){this.supported=capabilities?.environmentMetadata===1}
 reset(){this.supported=false}
 fields(){return this.supported?{fileTransferVersion:1,environment:{version:1,osRelease:release(),arch:arch(),shell:HOST_SHELL,homeDirectory:this.home,defaultCwd:this.home,fileRoots:[this.home],shellScope:'user',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}}:{}}
}
