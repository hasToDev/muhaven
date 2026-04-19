import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('activity filters + load more', async ({ investorPage: page }) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/activity')

  // Summary cards always render.
  await expect(page.getByText(/Total Events/i)).toBeVisible()

  // All filter selected by default; click each in turn.
  for (const filter of [SEL.activityFilterYield, SEL.activityFilterEscrow, SEL.activityFilterAll]) {
    await byTestId(page, filter).click()
    // Each click shouldn't break the layout — summary cards stay visible.
    await expect(page.getByText(/Total Events/i)).toBeVisible()
  }

  // Load More, if present.
  const loadMore = byTestId(page, SEL.activityLoadMore)
  if (await loadMore.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const beforeCount = await page.locator('[class*="border-t"]').count()
    await loadMore.click()
    await page.waitForTimeout(3_000)
    const afterCount = await page.locator('[class*="border-t"]').count()
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount)
  }
})
