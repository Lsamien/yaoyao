import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs'
/** Open first without following a final symlink, then check the actual inode. */
export function readPrivateUtf8(path:string,maxBytes:number){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
    const s=fstatSync(fd)
    if(!s.isFile()||(s.mode&0o077)||s.uid!==process.getuid?.()||s.size>maxBytes)throw new Error('private file required')
    const bytes=readFileSync(fd)
    if(bytes.length>maxBytes)throw new Error('private file size limit')
    return bytes.toString('utf8')
  }finally{closeSync(fd)}
}
