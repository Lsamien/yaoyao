import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {LAOA_DATA} from '../src/client/components/common/maus/laoa-data.ts';
const target=resolve(fileURLToPath(new URL('..',import.meta.url))),root=mkdtempSync(join(tmpdir(),'yaoyao-avatar-reference-'));
const source=JSON.parse(readFileSync(target+'/assets/mascot/laoa-source.json','utf8'));
const aliases={circle:'blob',square:'squircle',triangle:'triangle',capsule:'capsule',hexagon:'hex',cloud:'cloud',droplet:'drop'};
const shapes=['circle','ellipse','square','capsule','triangle','hexagon','cloud','droplet'];
const bodies=['cursor','blob','circle','squircle','capsule','drop','shield','hexagon','diamond','star'];
const expressions=['idle','happy','curious','drowsy','working','thinking','listening','sleeping','suspicious','proud'];
const cases=[...shapes.map(shape=>({id:'shape-'+shape,shape,color:'#00c875',expression:'idle'})),...bodies.map(bodyId=>({id:'body-'+bodyId,shape:'circle',bodyId,color:'#1488ff',expression:'happy'})),...expressions.map(expression=>({id:'face-'+expression,shape:'circle',color:'#f52ba5',expression})),...Array.from({length:25},(_,expressionIndex)=>({id:'raw-'+expressionIndex,shape:'circle',color:'#1488ff',expression:'idle',expressionIndex}))];
const style='body{margin:0;background:white;font:12px Arial}.grid{display:grid;grid-template-columns:repeat(7,128px);gap:12px;padding:12px}.case{display:flex;flex-direction:column;align-items:center;gap:6px;width:128px;height:128px}svg{width:96px;height:96px;overflow:visible}';
let reference='';
for(const c of cases){
 const g=c.bodyId?LAOA_DATA.bodies[c.bodyId]:LAOA_DATA.shapes[c.shape], original=c.bodyId?source.legacyBodies[c.bodyId]:source.shapes[aliases[c.shape]];
 const path=original?.path??g.path,fit=original?.fit??'',[x,y,k]=g.anchor;
 const rings=source.expressions[c.expressionIndex??source.pools[c.expression][0]],eyePath=r=>'M'+r.map(p=>p.join(' ')).join('L')+'Z';
 reference+=`<div class="case" data-testid="${c.id}"><svg viewBox="${g.viewport.join(' ')}"><defs><clipPath id="clip-${c.id}"><path d="${path}" transform="${fit}"/></clipPath></defs><path data-body d="${path}" transform="${fit}" fill="${c.color}"/><g clip-path="url(#clip-${c.id})"><g transform="translate(${x} ${y}) scale(${k}) translate(-120 -122.5)">${rings.map(r=>`<path data-eye fill="white" d="${eyePath(r)}"/>`).join('')}</g></g></svg><span>${c.id}</span></div>`;
}
for(const sub of ['reference','ported'])mkdirSync(root+'/'+sub,{recursive:true});
writeFileSync(root+'/reference/index.html',`<html><head><style>${style}</style></head><body><div class="grid">${reference}</div></body></html>`);
writeFileSync(root+'/ported/index.html',`<html><head><style>${style}</style></head><body><div id="app"></div><script type="module" src="/main.ts"></script></body></html>`);
writeFileSync(root+'/ported/main.ts',`import{createApp,h}from'vue';import AgentAvatar from '${target}/src/client/components/common/AgentAvatar.vue';import{defaultAgentIdentity,encodeAgentAvatar}from'${target}/src/shared/agentIdentity.ts';const cases=${JSON.stringify(cases)};createApp({render:()=>h('div',{class:'grid'},cases.map(c=>h('div',{class:'case','data-testid':c.id},[h(AgentAvatar,{name:c.id,avatar:encodeAgentAvatar({...defaultAgentIdentity(c.id),shape:c.shape,bodyId:c.bodyId??null,color:c.color,expression:c.expression}),size:96,animated:false,fixedTime:0,expressionIndex:c.expressionIndex}),h('span',c.id)])))}).mount('#app');`);
const servers=[];
for(const [sub,port]of[['reference',18806],['ported',18807]]){const server=await createServer({configFile:false,root:root+'/'+sub,plugins:sub==='ported'?[vue()]:[],resolve:{alias:{'@':target+'/src/client','@shared':target+'/src/shared',vue:target+'/node_modules/vue'}},server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[root,target]}}});await server.listen();servers.push(server);console.log(sub,port)}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{for(const server of servers)await server.close();process.exit()});
