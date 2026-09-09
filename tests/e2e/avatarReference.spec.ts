import {expect,test} from '@playwright/test'
import {readFileSync} from 'node:fs'
const source=JSON.parse(readFileSync(new URL('../../assets/mascot/laoa-source.json',import.meta.url),'utf8'))

test('matches LaoA original paths and all 25 eye expressions at full visible size',async({page,context},testInfo)=>{
  const reference=await context.newPage()
  await reference.goto('http://127.0.0.1:18806')
  await page.goto('http://127.0.0.1:18807')
  await expect(page.locator('[data-part=eye0]').first()).toHaveAttribute('d',/.+/)
  const ids=await page.locator('[data-testid]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-testid')!))
  expect(ids).toHaveLength(53)
  for(const id of ids){
    const svg=page.getByTestId(id).locator('svg')
    await expect(svg.locator('[data-part=mouth]')).toHaveCount(0)
    const measure=await svg.evaluate(svg=>{
      const viewport=(svg as SVGSVGElement).viewBox.baseVal,b=(svg.querySelector('[data-part=outline] path') as SVGGraphicsElement).getBBox()
      return {side:viewport.width,body:Math.max(b.width,b.height),centerX:viewport.x+viewport.width/2,bodyX:b.x+b.width/2,centerY:viewport.y+viewport.height/2,bodyY:b.y+b.height/2}
    })
    expect(measure.side,id).toBeCloseTo(measure.body,3)
    expect(measure.centerX,id).toBeCloseTo(measure.bodyX,3);expect(measure.centerY,id).toBeCloseTo(measure.bodyY,3)
    if(id.startsWith('raw-')){
      const index=Number(id.slice(4))
      for(let eye=0;eye<2;eye++)await expect(svg.locator(`[data-part=eye${eye}]`)).toHaveAttribute('d','M'+source.expressions[index][eye].map((p:number[])=>p.map(n=>n.toFixed(2)).join(' ')).join('L')+'Z')
    }
    async function pixels(locator:typeof svg){return locator.evaluate(async svg=>{
      const clone=svg.cloneNode(true) as SVGElement;clone.setAttribute('xmlns','http://www.w3.org/2000/svg');clone.setAttribute('width','96');clone.setAttribute('height','96')
      const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(new XMLSerializer().serializeToString(clone));await image.decode()
      const canvas=document.createElement('canvas');canvas.width=96;canvas.height=96;const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,96,96);ctx.drawImage(image,0,0,96,96);return Array.from(ctx.getImageData(0,0,96,96).data)
    })}
    const a=await pixels(svg),b=await pixels(reference.getByTestId(id).locator('svg'))
    const mean=a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]!),0)/a.length
    expect(mean,id).toBeLessThan(0.5)
    await svg.screenshot({path:testInfo.outputPath(id+'.png')})
  }
  await reference.screenshot({path:testInfo.outputPath('laoa-reference.png'),fullPage:true})
  await page.screenshot({path:testInfo.outputPath('web-avatar-grid.png'),fullPage:true})
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'})
  await page.addStyleTag({content:'body{background:#151515;color:#eee}'})
  await page.screenshot({path:testInfo.outputPath('web-avatar-grid-dark.png'),fullPage:true})
  await expect(page.locator('[data-animated=true]')).toHaveCount(0)
  await reference.close()
})
