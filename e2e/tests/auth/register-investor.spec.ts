import { roleTest as test, expect } from '../../lib/fixtures.js'
import { register, getSmartAddress } from '../../lib/auth.js'
import { INVESTOR_PASSKEY_NAME } from '../../lib/env.js'
import { preflightInvestor } from '../../lib/preflight.js'

test.describe.configure({ mode: 'serial' })

test('register investor passkey → land on /portfolio', async ({ investorPage: page }) => {
  test.setTimeout(0) // biometric + demo whitelist can take a while

  const address = await register(page, 'investor', INVESTOR_PASSKEY_NAME)

  expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/)
  expect(new URL(page.url()).pathname).toMatch(/\/(portfolio|marketplace)/)

  console.log(`\n→ Investor smart account: ${address}\n`)

  // Preflight gates every downstream investor test — if this is the first
  // run the fresh smart account isn't whitelisted + funded yet. Prompt for
  // setup-e2e, then re-check.
  await preflightInvestor(address)

  const viaPill = await getSmartAddress(page)
  expect(viaPill.toLowerCase()).toBe(address.toLowerCase())
})
