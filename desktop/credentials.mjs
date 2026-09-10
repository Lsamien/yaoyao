import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {homedir} from 'node:os'
const prefix=Buffer.from('YAOYAO-RUNNER-KEYCHAIN-1\n')
export class DesktopCredentials {
  constructor({home,helper,legacyDecrypt}){this.home=home;this.helper=helper;this.legacyDecrypt=legacyDecrypt}
  get account(){
    let identity=this.home
    try {
      const migration=JSON.parse(readFileSync(join(this.home,'.data-home-migration.json'),'utf8'))
      const old=join(homedir(),'.hermes-yaoyao')
      if(this.home===join(homedir(),'.yaoyao')&&migration.source===old&&migration.target===this.home)identity=old
    }catch{/* Fresh directories retain their own Keychain identity. */}
    return createHash('sha256').update(identity).digest('hex')
  }
  async invoke(operation,input){
    if(input.length>1048576)throw new Error('执行节点配置超过加密大小上限')
    return new Promise((resolve,reject)=>{
      const child=execFile(this.helper,[operation,this.account],{encoding:'buffer',timeout:30000,killSignal:'SIGKILL',maxBuffer:1048576},(error,stdout)=>{
        if(error)reject(new Error('无法访问当前数据目录的系统加密密钥，请完成钥匙串授权后重试'))
        else resolve(stdout)
      })
      child.stdin.on('error',()=>{});child.stdin.end(input)
    })
  }
  async encrypt(value){return Buffer.concat([prefix,await this.invoke('encrypt',Buffer.from(value))])}
  async decrypt(value){
    if(value.subarray(0,prefix.length).equals(prefix))return (await this.invoke('decrypt',value.subarray(prefix.length))).toString('utf8')
    // Existing safeStorage files remain readable after the user grants normal OS access.
    let timer
    try{return await Promise.race([this.legacyDecrypt(value),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('旧配置等待钥匙串授权，请完成系统授权后重试')),30000)})])}finally{clearTimeout(timer)}
  }
}
