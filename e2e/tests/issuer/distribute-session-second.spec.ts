import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { DISTRIBUTE_AMOUNT } from '../../lib/env.js'
import { distributionCount } from '../../lib/chain.js'

test.describe.configure({ mode: 'serial' })

/**
 * Follows `distribute.spec.ts` (alphabetical ordering — `distribute-session-second`
 * sorts after `distribute`). Expects the session kernel to already be installed,
 * so the second distribute should run without biometric prompts.
 *
 * Functional-only assertion: pipeline completes successfully AND the session
 * status pill was present at start. Quantitative prompt-count verification
 * lives in `regression/prompt-count-distribute.spec.ts` (requires frontend
 * instrumentation per PLAYWRIGHT_QA.md §5.6). Wall-time is NOT a reliable
 * prompt-count proxy — Arb Sepolia bundler latency + multiple UserOps can
 * easily push a silent pipeline past 2 minutes.
 */
test('second distribute — pipeline completes with session kernel active', async ({
  issuerPage: page,
}) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  // Session pill must already be active from a prior distribute in this context.
  const sessionPill = byTestId(page, SEL.sessionStatus)
  await expect(
    sessionPill,
    'session status pill not visible — run issuer/distribute.spec.ts first in the same session',
  ).toBeVisible({ timeout: 5_000 })

  const countBefore = await distributionCount()

  await page.goto('/distribute')

  const tokenSelect = byTestId(page, SEL.distributeTokenSelect)
  const values = await tokenSelect
    .locator('option')
    .evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    )
  await tokenSelect.selectOption(values[0])
  await byTestId(page, SEL.distributeAmountInput).fill(DISTRIBUTE_AMOUNT)

  await byTestId(page, SEL.distributeCta).click({ force: true })

  const receipt = byTestId(page, SEL.distributeReceipt)
  const error = byTestId(page, SEL.distributeError)

  await Promise.race([
    receipt.waitFor({ state: 'visible', timeout: 600_000 }),
    error.waitFor({ state: 'visible', timeout: 600_000 }),
  ])

  if (await error.isVisible().catch(() => false)) {
    const msg = (await error.innerText()).trim()
    throw new Error(`Second distribute failed:\n${msg}`)
  }

  expect(await distributionCount()).toBeGreaterThan(countBefore)
})
