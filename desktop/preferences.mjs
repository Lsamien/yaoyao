import {readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
export class DesktopPreferences {
  constructor(home){this.home=home;this.path=join(home,'desktop-preferences.json');this.value={backgroundAtLogin:false}}
  async load(){try{let source;try{source=await readFile(this.path,'utf8')}catch(error){if(error.code!=='ENOENT'||this.home!==join(homedir(),'.yaoyao'))throw error;source=await readFile(join(homedir(),'.hermes-yaoyao','desktop-preferences.json'),'utf8')}const value=JSON.parse(source);this.value={backgroundAtLogin:value.backgroundAtLogin===true}}catch(error){if(error.code!=='ENOENT')throw new Error('无法读取桌面偏好设置')}return this.value}
  async setBackgroundAtLogin(enabled){
    const value={backgroundAtLogin:enabled===true},temporary=this.path+'.'+randomUUID()
    await mkdir(this.home,{recursive:true,mode:0o700})
    try{await writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temporary,this.path);this.value=value}finally{await rm(temporary,{force:true})}
  }
}
