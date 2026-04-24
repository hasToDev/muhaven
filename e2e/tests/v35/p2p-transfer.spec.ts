import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

/**
 * Wave 3.5 P2P transfer flow on `/transfer`. Exercises the simulation-
 * first guard: typing an invalid recipient should keep the CTA disabled,
 * typing a verified recipient should enable it. The full submit path is
 * not exercised here unless an `E2E_TRANSFER_RECIPIENT` env is set —
 * blindly transferring to an unrelated address would mutate the test
 * fixture's balance unpredictably.
 */
test('P2P transfer — recipient simulation gates the CTA', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)

  await ensureInvestorReady(page, testInfo)

  await page.goto('/transfer')

  // The page only renders if a Wave 3.5 token is registered for the
  // investor. Skip when the testid never paints.
  const recipientInput = byTestId(page, SEL.transferRecipientInput)
  let hasUi = false
  try {
    await recipientInput.waitFor({ state: 'visible', timeout: 15_000 })
    hasUi = true
  } catch {
    hasUi = false
  }
  test.skip(!hasUi, 'TransferPage did not mount — Wave 3.5 token not deployed in this env.')

  // Garbage recipient → simulation should refuse.
  await recipientInput.fill('0xdeadbeef')
  const cta = byTestId(page, SEL.transferCta)
  await expect(cta).toBeDisabled({ timeout: 10_000 })

  // Valid format but presumably non-whitelisted → simulation still refuses.
  // Using a deterministic burn address rules out a flake from a passing
  // dev-mode bypass on a real account.
  await recipientInput.fill('0x000000000000000000000000000000000000dead')
  await expect(cta).toBeDisabled({ timeout: 15_000 })

  // Optional: when E2E_TRANSFER_RECIPIENT is set to a whitelisted address
  // we exercise the happy path. Otherwise we stop here — the simulation
  // gate is the assertion that matters for this spec.
  const realRecipient = process.env.E2E_TRANSFER_RECIPIENT
  if (!realRecipient || !/^0x[a-fA-F0-9]{40}$/.test(realRecipient)) {
    return
  }

  await recipientInput.fill(realRecipient)
  await byTestId(page, SEL.transferAmountInput).fill('1')

  // Wait for simulation to clear the CTA.
  await expect(cta).toBeEnabled({ timeout: 30_000 })

  await cta.click({ force: true })

  const success = byTestId(page, SEL.transferSuccessCard)
  const errorCard = byTestId(page, SEL.transferErrorCard)

  await Promise.race([
    success.waitFor({ state: 'visible', timeout: 600_000 }),
    errorCard.waitFor({ state: 'visible', timeout: 600_000 }),
  ])

  if (await errorCard.isVisible().catch(() => false)) {
    const msg = (await errorCard.innerText()).trim()
    throw new Error(`Transfer failed:\n${msg}`)
  }

  await expect(success).toBeVisible()
})
