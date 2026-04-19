import { roleTest as test, expect } from '../../lib/fixtures.js'
import { register, getSmartAddress } from '../../lib/auth.js'
import { ISSUER_PASSKEY_NAME } from '../../lib/env.js'
import { preflightIssuer } from '../../lib/preflight.js'

test.describe.configure({ mode: 'serial' })

test('register issuer passkey → land on /tokens', async ({ issuerPage: page }) => {
  test.setTimeout(0)

  const address = await register(page, 'issuer', ISSUER_PASSKEY_NAME)

  expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/)
  expect(new URL(page.url()).pathname).toMatch(/\/tokens/)

  console.log(`\n→ Issuer smart account: ${address}\n`)

  await preflightIssuer(address)

  const viaPill = await getSmartAddress(page)
  expect(viaPill.toLowerCase()).toBe(address.toLowerCase())
})
