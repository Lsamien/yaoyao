import {request} from 'node:http'

// A 10 MiB receive command expands to about 14 MiB as JSON/base64.
export function exchangeDesktopEnvironment(record,body){return new Promise((resolve,reject)=>{
 const url=new URL('/desktop/environment',record.url)
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')return reject(new Error('桌面服务地址无效'))
 const bytes=Buffer.from(JSON.stringify(body))
 const req=request(url,{method:'POST',headers:{'x-yaoyao-desktop-token':record.token,'content-type':'application/json','content-length':bytes.length}},res=>{
  let size=0;const chunks=[]
  res.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024)res.destroy(new Error('桌面命令超过限制'));else chunks.push(chunk)})
  res.on('error',reject)
  res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('桌面服务未连接');resolve(JSON.parse(Buffer.concat(chunks)))}catch(error){reject(error)}})
 })
 req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('桌面连接超时')));req.end(bytes)
})}
