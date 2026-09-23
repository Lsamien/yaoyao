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
    assert.deepEqual(await preferences.load(),{backgroundAtLogin:false,startupChoice:'ask',remoteServer:''})
    await preferences.setBackgroundAtLogin(true)
    assert.deepEqual(await new DesktopPreferences(home).load(),{backgroundAtLogin:true,startupChoice:'ask',remoteServer:''})
    if(process.platform!=='win32')assert.equal((await stat(preferences.path)).mode&0o777,0o600)
    await preferences.setBackgroundAtLogin(false)
    assert.deepEqual(await new DesktopPreferences(home).load(),{backgroundAtLogin:false,startupChoice:'ask',remoteServer:''})
  }finally{await rm(home,{recursive:true,force:true})}
})
test('startup choice persists independently of background login',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-desktop-preferences-'))
  try{
    const preferences=new DesktopPreferences(home)
    await preferences.load()
    await preferences.setStartupChoice('remote')
    assert.deepEqual(await new DesktopPreferences(home).load(),{backgroundAtLogin:false,startupChoice:'remote',remoteServer:''})
    await preferences.setBackgroundAtLogin(true)
    assert.deepEqual(await new DesktopPreferences(home).load(),{backgroundAtLogin:true,startupChoice:'remote',remoteServer:''})
    await preferences.setStartupChoice('local')
    assert.deepEqual(await new DesktopPreferences(home).load(),{backgroundAtLogin:true,startupChoice:'local',remoteServer:''})
    await preferences.setStartupChoice('ask')
    assert.deepEqual(await new DesktopPreferences(home).load(),{backgroundAtLogin:true,startupChoice:'ask',remoteServer:''})
    await preferences.setStartupChoice('nonsense')
    assert.equal((await new DesktopPreferences(home).load()).startupChoice,'ask')
    await preferences.setRemoteServer('http://192.168.1.10:15300')
    assert.deepEqual(await new DesktopPreferences(home).load(),{backgroundAtLogin:true,startupChoice:'ask',remoteServer:'http://192.168.1.10:15300'})
    await preferences.setRemoteServer(undefined)
    assert.equal((await new DesktopPreferences(home).load()).remoteServer,'')
  }finally{await rm(home,{recursive:true,force:true})}
})
