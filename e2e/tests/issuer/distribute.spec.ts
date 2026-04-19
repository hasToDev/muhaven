import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { DISTRIBUTE_AMOUNT } from '../../lib/env.js'
import { distributionCount } from '../../lib/chain.js'
import { ensureIssuerReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

/**
 * Two distribute flows live in the same file so declaration order strictly
 * controls execution order. Earlier we split them into `distribute.spec.ts`
 * and `distribute_session_second.spec.ts` and relied on filename sort, but
 * Playwright's actual ordering is not strict ASCII (observed on Windows:
 * `distribute_session_second.spec.ts` ran before `distribute.spec.ts` despite
 * `.` < `_` in ASCII). Merging removes any ambiguity — `test.describe.configure
 * ({ mode: 'serial' })` pins these to declaration order inside the worker.
 */
test.describe('distribute pipeline', () => {
  test('1) first distribute — receipt + on-chain count increments', async ({
    issuerPage: page,
  }, testInfo) => {
    test.setTimeout(0)

    await ensureIssuerReady(page, testInfo)

    const countBefore = await distributionCount()

    await page.goto('/distribute')

    // Select first active token.
    const tokenSelect = byTestId(page, SEL.distributeTokenSelect)
    await tokenSelect.waitFor({ state: 'visible', timeout: 15_000 })
    const values = await tokenSelect
      .locator('option')
      .evaluateAll((opts) =>
        opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v),
      )
    expect(values.length, 'no active tokens available to distribute').toBeGreaterThan(0)
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
      throw new Error(`Distribution failed:\n${msg}`)
    }

    // Receipt contains a distribution ID.
    const idText = await byTestId(page, SEL.distributeReceiptId).innerText()
    expect(idText).toMatch(/^#\d+/)

    // On-chain verification.
    const countAfter = await distributionCount()
    expect(
      countAfter,
      `distributionCount did not increase (before=${countBefore}, after=${countAfter})`,
    ).toBeGreaterThan(countBefore)
  })

  /**
   * Runs immediately after the first distribute — session kernel is already
   * installed so the second distribute should complete without any biometric
   * prompts. Functional-only assertion: pipeline completes AND session-status
   * pill is present at start. Quantitative prompt-count lives in
   * `regression/prompt-count-distribute.spec.ts` (requires frontend
   * instrumentation per PLAYWRIGHT_QA.md §5.6). Wall-time is NOT a reliable
   * prompt-count proxy — Arb Sepolia bundler latency can silently push a
   * session-covered pipeline past 2 minutes.
   */
  test('2) second distribute — pipeline completes with session kernel active', async ({
    issuerPage: page,
  }) => {
    test.setTimeout(0)

    // Session pill must already be active from the first distribute.
    const sessionPill = byTestId(page, SEL.sessionStatus)
    await expect(
      sessionPill,
      'session status pill not visible — first distribute did not install the session kernel',
    ).toBeVisible({ timeout: 5_000 })

    const countBefore = await distributionCount()

    await page.goto('/distribute')

    // Match test 1's pattern: wait for the select to render AND for at least
    // one real option to exist before reading values. `selectOption` auto-waits
    // on the select element itself but NOT on its contents — the tokens API
    // fetch + active-filter can run post-mount, so reading options too early
    // returns an empty array.
    const tokenSelect = byTestId(page, SEL.distributeTokenSelect)
    await tokenSelect.waitFor({ state: 'visible', timeout: 15_000 })
    await expect(tokenSelect.locator('option[value]:not([value=""])').first()).toBeAttached({
      timeout: 15_000,
    })
    const values = await tokenSelect
      .locator('option')
      .evaluateAll((opts) =>
        opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
      )
    expect(values.length, 'no active tokens available for second distribute').toBeGreaterThan(0)
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
})
