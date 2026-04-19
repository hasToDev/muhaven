import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

/**
 * Regression guard for the toPusdcUnits bug first fixed in 19A #16,
 * reintroduced during 19D.6 refactor, and re-fixed in 19E.4. The symptom
 * is `X.split is not a function` when `<input type="number">` coerces the
 * v-model ref to a JS number.
 */
test('issuer distribute amount "12.34" does not throw X.split', async ({ issuerPage: page }) => {
  test.setTimeout(0)

  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/distribute')

  // Select any token, fill "12.34", and simply observe — do NOT submit
  // (submitting would burn biometric prompts for something we don't need).
  const tokenSelect = byTestId(page, SEL.distributeTokenSelect)
  const values = await tokenSelect
    .locator('option')
    .evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    )
  if (values.length > 0) await tokenSelect.selectOption(values[0])

  await byTestId(page, SEL.distributeAmountInput).fill('12.34')

  // The distribution preview card recomputes per-investor average on input change.
  // If toPusdcUnits throws, the computed would error and the card would show broken UI.
  await expect(page.getByText(/Per investor \(avg\)/i)).toBeVisible()

  // Assert no split-related TypeError landed on the console.
  const splitErrors = consoleErrors.filter((e) => /split is not a function/i.test(e))
  expect(splitErrors, `unexpected split errors:\n${splitErrors.join('\n')}`).toEqual([])
})
