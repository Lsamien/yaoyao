/** Browser preview of the actual desktop HTML/CSS and controller, using fixture
 * services only. Run: node scripts/preview-desktop-onboarding.mjs */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const bridge = `
const flowReady = import('/desktop/onboarding.mjs').then(({DesktopOnboarding}) => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const flow = new DesktopOnboarding({
    remoteServer: () => 'http://192.168.1.10:15300',
    inspect: async () => { await delay(400); return {authenticated:false,setupRequired:flow.state.mode==='local'}; },
    prepareLocal: async () => {
      for (const [stage,message] of [['checking','正在检查运行环境…'],['installing','正在准备服务组件…'],['starting','正在启动并检查服务…']]) {
        flow.serviceChanged({phase:'starting',stage,message}); await delay(stage==='installing'?3000:1000);
      }
      return 'http://127.0.0.1:15300';
    },
    authenticate: async ({username,password}) => { await delay(600); if(password==='error')throw new Error('用户名或密码不正确'); return {username}; },
    activate: async () => {},
    navigate: async () => { document.querySelector('.intro h1').textContent='设置完成'; document.querySelector('.intro p').textContent='交互预览已完成，正式应用将在这里进入工作区。'; },
  });
  flow.open({mode:'remote',serverURL:'http://192.168.1.10:15300'});
  return flow;
});
window.yaoyaoDesktop={status:()=>flowReady.then(f=>f.snapshot()),selectServer:mode=>flowReady.then(f=>f.select(mode)),prepareServer:input=>flowReady.then(f=>f.prepare(input)),login:input=>flowReady.then(f=>f.submit(input)),forceSync:()=>flowReady.then(f=>f.prepare()),logs:async()=>{document.getElementById('install-log').textContent+='\\n交互预览使用模拟服务，无本机安装日志。';}};
window.addEventListener('DOMContentLoaded',()=>{document.querySelector('.brand>span').textContent='交互预览 · 模拟服务';});
`
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/preview-bridge.js') { res.setHeader('content-type', 'text/javascript'); res.end(bridge); return }
  if (path === '/') { res.writeHead(302, { location: '/desktop/boot.html' }); res.end(); return }
  const allowed = ['boot.html', 'boot.css', 'boot.js', 'boot-icons.svg', 'icon.png', 'onboarding.mjs', 'remote-login.mjs']
  if (!allowed.some(file => path === '/desktop/' + file)) { res.writeHead(404); res.end(); return }
  try {
    let data = await readFile(resolve(root, '.' + path))
    if (path.endsWith('boot.html')) data = data.toString().replace('<script src="boot.js">', '<script src="/preview-bridge.js"></script><script src="boot.js">')
    res.setHeader('content-type', types[extname(path)]); res.end(data)
  } catch { res.writeHead(404); res.end() }
})
server.listen(Number(process.env.PORT || 4388), '127.0.0.1', () => console.log(`Desktop onboarding preview: http://127.0.0.1:${server.address().port}`))
