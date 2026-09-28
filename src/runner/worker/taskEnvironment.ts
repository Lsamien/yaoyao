import type {TaskEnvironment} from '../../shared/executionEnvironment.js'

// Credentials travel over stdin, never argv, process-global environment, or a
// workspace file. Temporary files belong to this command and are removed even
// when its subprocess fails. The command remains in the provider's process group.
export const TASK_COMMAND = `import json,os,sys,tempfile,subprocess,pathlib,signal
p=json.load(sys.stdin)
def stop(signum,frame):
    raise SystemExit(128+signum)
signal.signal(signal.SIGTERM,stop)
with tempfile.TemporaryDirectory(prefix='yaoyao-task-',dir='/tmp') as directory:
    env=dict(os.environ)
    env.update(p['environment']['variables'])
    for item in p['environment']['files']:
        root=pathlib.Path(directory)/item['envKey']
        root.mkdir(mode=0o700)
        target=root/item['name']
        target.write_text(item['content'])
        target.chmod(0o600)
        env[item['envKey']]=str(root)
    result=subprocess.run(['/bin/bash','-lc',p['command']],env=env,stdin=subprocess.DEVNULL)
    sys.exit(result.returncode)
`
export function redactTaskOutput<T>(value:T,environment:TaskEnvironment|undefined):T {
  if(!environment)return value
  const secrets=[...Object.values(environment.variables),...environment.files.flatMap(f=>{
    try{return [f.content,...JSON.stringify(JSON.parse(f.content)).matchAll(/"([^"\\]{8,})"/g)].map(v=>typeof v==='string'?v:v[1]!)}catch{return [f.content]}
  })].filter(Boolean).sort((a,b)=>b.length-a.length)
  const visit=(v:unknown):unknown=>typeof v==='string'?secrets.reduce((s,secret)=>s.split(secret).join('[已隐藏授权]'),v):Array.isArray(v)?v.map(visit):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,item])=>[k,visit(item)])):v
  return visit(value) as T
}
