/** Enter through the native local-admin flow, then set isolated fixture credentials. */
export async function enterLocal(page, { username = 'desktop-fixture', password = 'desktop-fixture-password' } = {}) {
  await page.waitForURL(url => url.protocol === 'http:' || url.protocol === 'https:', { timeout: 90000 })
  await page.evaluate(async ({username,password}) => {
    const bootstrap = await (await fetch('/api/app/bootstrap')).json()
    if (!bootstrap.user?.localDesktop) throw new Error('Native administrator session was not established')
    const response = await fetch('/api/app/account/credentials', { method: 'PUT',
      headers: {'Content-Type':'application/json','X-CSRF-Token':bootstrap.csrfToken},
      body: JSON.stringify({username,currentPassword:'',newPassword:password}) })
    if (!response.ok) throw new Error('Fixture account configuration failed')
  }, {username,password})
  // The native service may finish its own navigation after credentials rotate.
  // Retry only interrupted navigation; all other browser failures remain errors.
  const url = new URL('/conversations', page.url()).href
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(url); break }
    catch (error) {
      if (attempt >= 2 || !String(error.message).includes('net::ERR_ABORTED')) throw error
      await page.waitForLoadState('load')
    }
  }
}
