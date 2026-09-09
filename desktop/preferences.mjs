import {readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
export class DesktopPreferences {
  constructor(home){this.home=home;this.path=join(home,'desktop-preferences.json');this.value={backgroundAtLogin:false}}
  async load(){try{const value=JSON.parse(await readFile(this.path,'utf8'));this.value={backgroundAtLogin:value.backgroundAtLogin===true}}catch(error){if(error.code!=='ENOENT')throw new Error('无法读取桌面偏好设置')}return this.value}
  async setBackgroundAtLogin(enabled){
    const value={backgroundAtLogin:enabled===true},temporary=this.path+'.'+randomUUID()
    await mkdir(this.home,{recursive:true,mode:0o700})
    try{await writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temporary,this.path);this.value=value}finally{await rm(temporary,{force:true})}
  }
}
