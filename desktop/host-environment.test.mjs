import {test} from 'node:test'
import assert from 'node:assert/strict'
import {arch,release} from 'node:os'
import {HostEnvironmentReporter} from './host-environment.mjs'
import {HOST_SHELL} from './host-files.mjs'

test('only sends optional host facts after explicit server negotiation and resets for old servers',()=>{
 const reporter=new HostEnvironmentReporter('/Users/fixture')
 assert.deepEqual(reporter.fields(),{})
 reporter.accept({environmentMetadata:1})
 const {fileTransferVersion,environment}=reporter.fields()
 assert.equal(fileTransferVersion,1)
 assert.deepEqual(environment,{version:1,osRelease:release(),arch:arch(),shell:HOST_SHELL,homeDirectory:'/Users/fixture',defaultCwd:'/Users/fixture',fileRoots:['/Users/fixture'],shellScope:'user',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})
 assert.equal(Object.keys(environment).some(key=>/token|password|env|secret/i.test(key)),false)
 reporter.accept(undefined)
 assert.deepEqual(reporter.fields(),{})
 reporter.accept({environmentMetadata:2})
 assert.deepEqual(reporter.fields(),{})
 reporter.accept({environmentMetadata:1});reporter.reset()
 assert.deepEqual(reporter.fields(),{})
})
