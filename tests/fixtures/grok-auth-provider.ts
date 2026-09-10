/** Isolated OAuth provider for browser acceptance. Never delegates to network. */
export class FixtureGrokAuthProvider {
  private accepted=new Set<string>()
  rejectCloud=false
  pollCount=0
  refreshCount=0
  accept(uuid:string){this.accepted.add(uuid)}
  private token(){return 'fixture.'+Buffer.from(JSON.stringify({sub:'grok-auth-fixture',email:'grok-fixture@example.test',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.signature'}
  fetch:typeof fetch=async(input,init={})=>{
    const url=new URL(String(input))
    if(url.pathname==='/auth/poll'){this.pollCount++;return this.accepted.has(url.searchParams.get('uuid')??'')?Response.json({accessToken:this.token(),refreshToken:'grok-fixture-refresh'}):new Response('',{status:404})}
    if(url.pathname==='/oauth/token'){this.refreshCount++;return Response.json({access_token:this.token(),refresh_token:'grok-fixture-refresh-rotated'})}
    if(url.pathname.endsWith('/GetSandBoxRunState'))return this.rejectCloud?Response.json({code:'unauthenticated'},{status:401}):Response.json({state:'SAND_BOX_RUN_STATE_RUNNING'})
    if(url.pathname.endsWith('/GetMe'))return Response.json({email:'grok-fixture@example.test',firstName:'Grok',lastName:'Fixture'})
    throw new Error('Unexpected isolated Grok auth request: '+url.pathname)
  }
}
