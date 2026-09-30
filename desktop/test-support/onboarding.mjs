/** Enter through the native local-admin flow, then set isolated fixture credentials. */
export async function enterLocal(page, { username = 'desktop-fixture', password = 'desktop-fixture-password' } = {}) {
  await page.waitForURL(url => url.protocol === 'http:' || url.protocol === 'https:', { timeout: 90000 })
  // Rotate fixture credentials outside the SPA: its in-flight requests still
  // carry the previous session and can otherwise trigger native login recovery.
  const origin = new URL(page.url()).origin
  const fixtureURL = `${origin}/__desktop_fixture_credentials__`
  await page.route(fixtureURL, route => route.fulfill({ contentType: 'text/html', body: '<title>Fixture account setup</title>' }))
  try {
    await page.goto(fixtureURL)
    await page.evaluate(async ({username,password}) => {
      const bootstrap = await (await fetch('/api/app/bootstrap')).json()
      if (!bootstrap.user?.localDesktop) throw new Error('Native administrator session was not established')
      const response = await fetch('/api/app/account/credentials', { method: 'PUT',
        headers: {'Content-Type':'application/json','X-CSRF-Token':bootstrap.csrfToken},
        body: JSON.stringify({username,currentPassword:'',newPassword:password}) })
      if (!response.ok) throw new Error('Fixture account configuration failed')
    }, {username,password})
  } finally { await page.unroute(fixtureURL) }
  await page.goto(`${origin}/conversations`)
}
