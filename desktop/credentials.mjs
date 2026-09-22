import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {homedir} from 'node:os'
const prefix=Buffer.from('YAOYAO-RUNNER-KEYCHAIN-1\n')
const windowsPrefix=Buffer.from('YAOYAO-WINDOWS-DPAPI-1\n')
export class DesktopCredentials {
  constructor({home,helper,legacyDecrypt,platform=process.platform,safeStorage}){Object.assign(this,{home,helper,legacyDecrypt,platform,safeStorage})}
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
  async encrypt(value){
    if(this.platform==='win32'){
      if(Buffer.byteLength(value)>1048576)throw new Error('电脑配置超过加密大小上限')
      if(!await this.safeStorage?.isAsyncEncryptionAvailable())throw new Error('系统加密暂不可用，请稍后重试')
      return Buffer.concat([windowsPrefix,await this.safeStorage.encryptStringAsync(value)])
    }
    return Buffer.concat([prefix,await this.invoke('encrypt',Buffer.from(value))])
  }
  async decrypt(value){
    if(this.platform==='win32'){
      if(!value.subarray(0,windowsPrefix.length).equals(windowsPrefix))throw new Error('此电脑配置不属于 Windows，请重新登录授权')
      try{return (await this.safeStorage.decryptStringAsync(value.subarray(windowsPrefix.length))).result}
      catch{throw new Error('无法解锁电脑配置，请使用原 Windows 账号或重新登录授权')}
    }
    if(value.subarray(0,prefix.length).equals(prefix))return (await this.invoke('decrypt',value.subarray(prefix.length))).toString('utf8')
    // Existing safeStorage files remain readable after the user grants normal OS access.
    let timer
    try{return await Promise.race([this.legacyDecrypt(value),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('旧配置等待钥匙串授权，请完成系统授权后重试')),30000)})])}finally{clearTimeout(timer)}
  }
}
