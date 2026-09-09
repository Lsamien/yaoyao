import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DesktopPreferences} from './preferences.mjs'
test('background login remains opt-in and persists without changing system login permission',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-desktop-preferences-'))
  try{
    const preferences=new DesktopPreferences(home)
    assert.deepEqual(await preferences.load(),{backgroundAtLogin:false})
    await preferences.setBackgroundAtLogin(true)
    assert.deepEqual(await new DesktopPreferences(home).load(),{backgroundAtLogin:true})
    assert.equal((await stat(preferences.path)).mode&0o777,0o600)
    await preferences.setBackgroundAtLogin(false)
    assert.deepEqual(await new DesktopPreferences(home).load(),{backgroundAtLogin:false})
  }finally{await rm(home,{recursive:true,force:true})}
})
