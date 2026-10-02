import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export function writeNpmFixture(root, version, broken = false) {
  const release = { schemaVersion: 1, releaseVersion: version, webVersion: version, gitTag: `v${version}` }
  const files = {
    'package.json': JSON.stringify({ name: '@lsamien/yaoyao', version, type: 'module', engines: { node: '>=24' }, fixtureBroken: broken }),
    'release.json': JSON.stringify(release),
    'build-info.json': JSON.stringify({ commit: createHash('sha256').update(version).digest('hex').slice(0, 40), buildNumber: 1, dirty: false }),
    'dist/index.html': '<html>npm fixture</html>',
    'bin/hermes-yaoyao.mjs': '// fixture launcher\n',
    'bin/hermes-yaoyao-updater.mjs': '// fixture updater\n',
    'dist-server/server/index.js': `
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
const root=process.cwd(),home=realpathSync(process.env.HERMES_YAOYAO_HOME),port=Number(process.env.HERMES_YAOYAO_PORT);
const release=JSON.parse(readFileSync(join(root,'release.json'))),build=JSON.parse(readFileSync(join(root,'build-info.json'))),pkg=JSON.parse(readFileSync(join(root,'package.json')));
const db=new DatabaseSync(join(home,'workspace.sqlite3'));db.exec('CREATE TABLE IF NOT EXISTS fixture_data (value TEXT)');
if(pkg.fixtureBroken){db.exec("INSERT INTO fixture_data VALUES ('failed update')");writeFileSync(join(home,'user.txt'),'failed update');}
const identity={protocol:1,pid:process.pid,instanceId:randomUUID(),dataKey:createHash('sha256').update(home).digest('hex'),version:release.webVersion,build,url:'http://127.0.0.1:'+port,maintenanceProtocol:1};
writeFileSync(join(home,'service-instance.json'),JSON.stringify(identity));let quiesced=false;
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');
 if(req.url==='/desktop/service')res.end(JSON.stringify({...identity,quiesced}));
 else if(req.url==='/desktop/service/quiesce'){quiesced=req.method==='POST';res.end(JSON.stringify({quiesced}));}
 else if(req.url==='/healthz')res.end(JSON.stringify({ok:!pkg.fixtureBroken}));
 else if(req.url==='/api/status')res.end(JSON.stringify({server_kind:'yaoyao-web',version:release.webVersion}));
 else{res.statusCode=404;res.end('{}');}});
server.listen(port,'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0)}));
`,
  }
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  return release
}
