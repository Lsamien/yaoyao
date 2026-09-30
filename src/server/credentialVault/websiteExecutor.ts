import {chromium,type Browser,type BrowserContext,type Page} from 'playwright'
import {resolve} from 'node:path'
import type {IsolationGate,CredentialExecutionReceipt} from './executor.js'
import type {VaultEntry,LeaseInput} from './schema.js'
/** Standard HTML POST form only. One private browser/context per lease; no
 * persistent profile, public CDP port, fill/JS API, screenshots or page output. */
export class WebsiteFormExecutor {
  constructor(private home:string,private gate:IsolationGate,private testCA?:Buffer){}
  async execute(entry:Readonly<VaultEntry>,input:LeaseInput,signal:AbortSignal):Promise<CredentialExecutionReceipt>{
    this.gate.assert();signal.throwIfAborted()
    const plan=entry.usage
    if(entry.target.kind!=='website'||input.target.kind!=='website'||input.operation!=='website.login'||entry.target.origin!==input.target.origin||plan?.kind!=='website.form')
      return {status:'manual_takeover_required',reason:'usage_policy_required',submitted:false}
    // Test-only custom CA is not a TLS bypass: Chromium explicitly trusts this
    // certificate's SPKI. It is restricted to loopback and never set by CLI.
    const base=new URL(entry.target.origin)
    if(this.testCA&&base.hostname!=='127.0.0.1')throw new Error('fixture CA is loopback only')
    let browser:Browser|undefined,context:BrowserContext|undefined,page:Page|undefined,unsafe=false,submitted=false
    const abort=()=>{void context?.close().catch(()=>{});void browser?.close().catch(()=>{})}
    signal.addEventListener('abort',abort,{once:true})
    try{
      const args=['--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-background-networking']
      if(this.testCA){const {X509Certificate,createHash}=await import('node:crypto');args.push('--ignore-certificate-errors-spki-list='+createHash('sha256').update(new X509Certificate(this.testCA).publicKey.export({type:'spki',format:'der'})).digest('base64'))}
      browser=await chromium.launch({headless:true,chromiumSandbox:true,timeout:10000,args,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:resolve(this.home),TMPDIR:resolve(this.home),LANG:'en_US.UTF-8'}})
      signal.throwIfAborted();this.gate.assert()
      context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block',permissions:[]})
      context.setDefaultTimeout(5000);context.setDefaultNavigationTimeout(5000)
      await context.routeWebSocket('**/*',route=>route.close())
      page=await context.newPage()
      context.on('page',other=>{if(other!==page){unsafe=true;void other.close().catch(()=>{})}})
      page.on('dialog',dialog=>{unsafe=true;void dialog.dismiss().catch(()=>{})})
      page.on('frameattached',()=>{unsafe=true})
      await context.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url())
        const main=request.isNavigationRequest()&&request.frame()===page!.mainFrame()
        const approvedNavigation=main&&[plan.loginPath,plan.submitPath,plan.successPath,...(plan.logoutPath?[plan.logoutPath]:[])].includes(url.pathname)&&!url.search&&!url.hash
        const resource=!request.isNavigationRequest()&&request.method()==='GET'&&['script','stylesheet','image','font'].includes(request.resourceType())
        const allowed=url.origin===base.origin&&(approvedNavigation||resource)&&(!request.redirectedFrom()||request.method()==='GET'&&url.pathname===plan.successPath)
          &&(request.method()==='GET'||main&&request.method()==='POST'&&url.pathname===plan.submitPath)&&!signal.aborted
        if(!allowed){unsafe=true;await route.abort();return}
        await route.continue()
      })
      await page.goto(new URL(plan.loginPath,base).href,{waitUntil:'domcontentloaded'})
      const form=page.locator(`form[id="${plan.formId}"]`),user=form.locator(`input[name="${plan.usernameName}"]`),password=form.locator(`input[name="${plan.passwordName}"]`),submit=form.locator('button[type="submit"],input[type="submit"]')
      if(unsafe||page.frames().length!==1||await form.count()!==1||await user.count()!==1||await password.count()!==1||await submit.count()!==1||plan.usernameName===plan.passwordName)
        return {status:'manual_takeover_required',reason:'unsupported_form_flow',submitted:false}
      const metadata=await form.evaluate(el=>{const f=el as HTMLFormElement;return {method:f.method,action:f.action,enctype:f.enctype}})
      const action=new URL(metadata.action)
      if(metadata.method.toLowerCase()!=='post'||metadata.enctype!=='application/x-www-form-urlencoded'||action.origin!==base.origin||action.pathname!==plan.submitPath||action.search||action.hash||await password.getAttribute('type')!=='password')
        return {status:'manual_takeover_required',reason:'unsupported_form_flow',submitted:false}
      this.gate.assert();signal.throwIfAborted()
      await user.fill(entry.username);await password.fill(entry.secret)
      if(unsafe) return {status:'manual_takeover_required',reason:'unsupported_form_flow',submitted:false}
      submitted=true
      await Promise.all([page.waitForURL(url=>url.origin===base.origin&&url.pathname===plan.successPath&&!url.search&&!url.hash,{waitUntil:'domcontentloaded'}),submit.click()])
      signal.throwIfAborted();this.gate.assert()
      if(unsafe||page.frames().length!==1||await page.locator(plan.successSelector).count()!==1||!await page.locator(plan.successSelector).isVisible())
        return {status:'manual_takeover_required',reason:'unsupported_form_flow',submitted:true}
      if(plan.logoutPath){const response=await page.goto(new URL(plan.logoutPath,base).href,{waitUntil:'domcontentloaded'});if(!response||response.status()>=300||unsafe)return {status:'manual_takeover_required',reason:'unsupported_form_flow',submitted:true}}
      // The authenticated context is destroyed below. Cookies/DOM/network output
      // are never handed to generic tools or included in the model receipt.
      return {status:'complete',operation:'website.login'}
    }catch{
      signal.throwIfAborted()
      return {status:'manual_takeover_required',reason:'unsupported_form_flow',submitted}
    }finally{
      signal.removeEventListener('abort',abort)
      await context?.clearCookies().catch(()=>{});await context?.close().catch(()=>{});await browser?.close().catch(()=>{})
    }
  }
}
