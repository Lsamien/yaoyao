/** Complete the real native first-run form; never bypass authentication. */
export async function enterLocal(page, { username = 'desktop-fixture', password = 'desktop-fixture-password' } = {}) {
  await page.locator('#login-form').waitFor({ timeout: 90000 })
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  if (await page.locator('#confirmation-field').isVisible()) await page.locator('#confirmation').fill(password)
  await page.locator('#submit').click()
}
