import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {DesktopCredentials} from './credentials.mjs'
test('native Keychain encryption is scoped to a directory and authenticates ciphertext',{timeout:30000},async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-keychain-')))
  const credentials=new DesktopCredentials({home,helper:resolve('.desktop-build/keychain-helper-dev'),legacyDecrypt:async()=>{throw new Error('legacy')}})
  try{
    const value='{"token":"fixture-private-machine-token"}',encrypted=await credentials.encrypt(value)
    assert.equal(encrypted.includes('fixture-private-machine-token'),false)
    assert.equal(await credentials.decrypt(encrypted),value)
    const changed=Buffer.from(encrypted);changed[changed.length-1]^=1
    await assert.rejects(credentials.decrypt(changed))
    const other=new DesktopCredentials({home:home+'-other',helper:credentials.helper,legacyDecrypt:credentials.legacyDecrypt})
    await assert.rejects(other.decrypt(encrypted))
    await assert.rejects(promisify(execFile)(resolve('.desktop-build/keychain-helper'),['decrypt',credentials.account]),/只允许所属 App/)
  }finally{await promisify(execFile)('/usr/bin/security',['delete-generic-password','-s','cn.samien.yaoyao.runner-key.v1','-a',credentials.account]).catch(()=>{});await rm(home,{recursive:true,force:true})}
})
