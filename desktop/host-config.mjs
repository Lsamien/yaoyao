/** desktop-host.json downloaded once from the server's computer settings panel. */
export function parseDesktopHostConfiguration(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('电脑配置无效')
 if(value.protocol!==1)throw new Error('电脑配置协议不兼容，请更新夭夭')
 let web
 try{web=new URL(value.serverURL)}catch{throw new Error('夭夭服务地址无效')}
 if(!['http:','https:'].includes(web.protocol)||web.username||web.password||web.search||web.hash||web.pathname!=='/')throw new Error('夭夭服务地址无效')
 if(web.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(web.hostname)&&value.allowInsecureLan!==true)throw new Error('远程电脑需要 HTTPS，或使用注册时勾选可信局域网 HTTP 的配置')
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(value.hostId)))throw new Error('电脑编号无效，请从夭夭重新下载配置')
 if(typeof value.token!=='string'||value.token.length<32||value.token.length>4096)throw new Error('电脑凭据无效，请从夭夭重新下载配置')
 return {protocol:1,serverURL:web.origin,hostId:value.hostId,token:value.token,allowInsecureLan:value.allowInsecureLan===true}
}
