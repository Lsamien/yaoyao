import {parseArgs} from 'node:util'
import {fileURLToPath} from 'node:url'
import {ComputerImages,writeManifest} from './images.js'
import {ContainerComputerProvider} from './container.js'
import {randomUUID} from 'node:crypto'
import {tmpdir} from 'node:os'
try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{runtime:{type:'string',default:'docker'},image:{type:'string'},archive:{type:'string'},output:{type:'string'},recipe:{type:'string'}}})
  if(!['docker','podman'].includes(values.runtime!))throw new Error('运行时必须为 docker 或 podman')
  const runtime=values.runtime as 'docker'|'podman',images=new ComputerImages(runtime)
  await new ContainerComputerProvider(runtime,randomUUID(),tmpdir()).verifyRuntime()
  let result
  switch(positionals[0]){
    case 'prepare': result=await images.prepare(values.recipe??fileURLToPath(new URL('./computer-image',import.meta.url)));break
    case 'inspect':if(!values.image)throw new Error('需要 --image sha256:完整镜像ID');result=await images.inspect(values.image);break
    case 'export':if(!values.image||!values.archive)throw new Error('需要 --image 和 --archive');result=await images.export(values.image,values.archive);break
    case 'import':if(!values.archive)throw new Error('需要 --archive');result=await images.import(values.archive);break
    default:throw new Error('用法：runner-image prepare|inspect|export|import [--runtime docker|podman] [--image ID] [--archive 文件] [--output 清单.json]')
  }
  if(values.output)await writeManifest(values.output,result)
  process.stdout.write(JSON.stringify(result,null,2)+'\n')
}catch(error){process.stderr.write(`${error instanceof Error?error.message:'镜像操作失败'}\n`);process.exitCode=1}
