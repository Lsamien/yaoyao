// @vitest-environment node
import {expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium,type Page} from 'playwright'
import {BrowserRuntime,type BrowserScope,type BrowserAction} from '../../src/runner/browser/runtime.js'

// Real Chromium, isolated profile and synthetic page. No external website or account.
it.runIf(process.env.YAOYAO_BROWSER_SMOKE==='1')('real Chromium: sliders, text selection, HTML drop and live holds with cancellation',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-browser-drag-')))
  const scope:BrowserScope={ownerKey:'drag-test',environmentId:'drag-bot',profile:'temporary'}
  let page!:Page
  const runtime=new BrowserRuntime({root,enabled:true,launcher:{launchPersistentContext:async(directory,options)=>{
    const context=await chromium.launchPersistentContext(directory,options);page=context.pages()[0]!
    await page.setContent(`<!doctype html><style>
      body{margin:40px;font:20px monospace}input{width:400px;height:30px;margin:0}p{width:700px;margin:30px 0}
      #source,#target{display:inline-block;width:180px;height:100px;background:#ddd;margin-right:80px}
      </style><input type="range" min="0" max="100" value="0"><p>Drag this sentence to select the text.</p>
      <div id="source" draggable="true">Drag me</div><div id="target">Drop here</div><output id="drops">0</output>
      <script>
      window.buttons=0;window.releases=0;
      document.addEventListener('mousemove',e=>window.buttons=e.buttons);
      document.addEventListener('mouseup',()=>window.releases++);
      source.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','fixture'));
      target.addEventListener('dragover',e=>e.preventDefault());
      target.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.getData('text/plain')==='fixture')drops.textContent=String(+drops.textContent+1)});
      </script>`)
    return context
  }}})
  let generation=0
  const execute=(action:BrowserAction)=>runtime.execute(scope,{generation,operationId:randomUUID(),action})
  try{
    generation=(await runtime.open(scope)).generation
    const slider=(await page.locator('input').boundingBox())!,y=slider.y+slider.height/2
    await execute({kind:'drag',fromX:slider.x+8,fromY:y,toX:slider.x+390,toY:y})
    expect(Number(await page.locator('input').inputValue())).toBeGreaterThan(95)
    const text=(await page.locator('p').boundingBox())!
    await execute({kind:'drag',fromX:text.x+1,fromY:text.y+10,toX:text.x+240,toY:text.y+10})
    expect(await page.evaluate(()=>getSelection()?.toString())).toContain('Drag this sentence')
    const source=(await page.locator('#source').boundingBox())!,target=(await page.locator('#target').boundingBox())!
    const start={x:source.x+40,y:source.y+40},end={x:target.x+40,y:target.y+40}
    await execute({kind:'drag',fromX:start.x,fromY:start.y,toX:end.x,toY:end.y})
    expect(await page.locator('#drops').innerText()).toBe('1')
    const gestureId=randomUUID()
    await execute({kind:'pointer',gestureId,phase:'start',x:slider.x+390,y})
    const releases=await page.evaluate(()=>(window as any).releases)
    await execute({kind:'pointer',gestureId,phase:'move',x:slider.x+200,y})
    // This observation happens while the button is still held, before pointer end.
    expect(Number(await page.locator('input').inputValue())).toBeGreaterThan(45)
    expect(Number(await page.locator('input').inputValue())).toBeLessThan(55)
    expect(await page.evaluate(()=>(window as any).buttons)).toBe(1)
    expect(await page.evaluate(()=>(window as any).releases)).toBe(releases)
    await execute({kind:'screenshot'})
    await execute({kind:'pointer',gestureId,phase:'end',x:slider.x+300,y})
    expect(Number(await page.locator('input').inputValue())).toBeGreaterThan(70)
    expect(await page.evaluate(()=>(window as any).releases)).toBe(releases+1)
    const dropId=randomUUID()
    await execute({kind:'pointer',gestureId:dropId,phase:'start',...start})
    await execute({kind:'pointer',gestureId:dropId,phase:'move',...end})
    await execute({kind:'pointer',gestureId:dropId,phase:'end',...end})
    expect(await page.locator('#drops').innerText()).toBe('2')
    const cancelId=randomUUID()
    await execute({kind:'pointer',gestureId:cancelId,phase:'start',...start})
    await execute({kind:'pointer',gestureId:cancelId,phase:'move',...end})
    await execute({kind:'pointer',gestureId:cancelId,phase:'cancel',...end})
    expect(await page.locator('#drops').innerText()).toBe('2')
    await page.mouse.move(100,700)
    expect(await page.evaluate(()=>(window as any).buttons)).toBe(0)
  }finally{await runtime.shutdown();await rm(root,{recursive:true,force:true})}
},30000)
