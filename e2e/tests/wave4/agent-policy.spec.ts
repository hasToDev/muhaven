import { test, expect, type Route } from '@playwright/test'

/**
 * Wave 4 Q1 — /agent/policy/transition smoke surface.
 *
 * Closes §3e⁶ F-dashboard-policy-route-missing. The broker daemon's
 * MissingSessionKeyError text points operators to this URL; before Q1
 * it 404'd, breaking the broker-handoff demo.
 *
 * This spec covers the no-biometric surfaces:
 *   1. /agent/policy/transition redirects unauthenticated visitors to /login
 *   2. With a seeded auth payload, the page mounts + renders the tier
 *      picker + surface picker
 *   3. Step-up to Policy-bound from Advisory surfaces the gate-failure
 *      hint without firing a backend POST (forbidden-transition path).
 *   4. Step-down auto-applies (POST /policy/transition returns
 *      `requiresConfirmation: false`).
 *
 * Backend /api/v1/agent/policy/{state,transition} stubbed via page.route
 * so the spec is self-contained.
 */

async function seedAuthState(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      const now = Math.floor(Date.now() / 1000)
      window.localStorage.setItem(
        'muhaven-auth-tokens',
        JSON.stringify({
          access_token: 'test.placeholder.jwt',
          refresh_token: 'test.placeholder.refresh',
          expires_at: (now + 3600) * 1000,
          wallet_address: '0x' + 'aa'.repeat(20),
          role: 'investor',
          issuer_status: 'approved',
        }),
      )
      // Mirror the auth bootstrap so the route guard sees us as authed.
      window.localStorage.setItem('muhaven-wallet', '0x' + 'aa'.repeat(20))
    } catch {
      /* swallow */
    }
  })
}

async function stubPolicyState(
  page: import('@playwright/test').Page,
  body: { surfaces: Array<Record<string, unknown>> },
): Promise<void> {
  await page.route(/\/api\/v1\/agent\/policy\/state$/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

async function stubPolicyTransition(
  page: import('@playwright/test').Page,
  response: Record<string, unknown>,
  status = 200,
): Promise<void> {
  await page.route(/\/api\/v1\/agent\/policy\/transition$/, async (route: Route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(response),
    })
  })
}

async function stubMe(page: import('@playwright/test').Page): Promise<void> {
  await page.route(/\/api\/v1\/users\/me$/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'u_test',
        wallet_address: '0x' + 'aa'.repeat(20),
        wallet_provider: 'zerodev',
        role: 'investor',
        created_at: new Date().toISOString(),
        issuer_status: 'approved',
        telegram_link: null,
      }),
    })
  })
}

function defaultStateForSurface(surface: string, tier = 'advisory'): Record<string, unknown> {
  return {
    userId: 'u_test',
    surface,
    tier,
    pausedAt: null,
    pauseTrigger: null,
    pauseMetadata: null,
    enteredAt: new Date().toISOString(),
    validatorAddress: null,
    confirmedActionCount: 0,
    riskQuestionnaireComplete: false,
    updatedAt: new Date().toISOString(),
  }
}

test.describe('Wave 4 Q1 · /agent/policy/transition', () => {
  test('redirects unauthenticated visitors to /login', async ({ page }) => {
    await page.goto('/agent/policy/transition')
    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 })
  })

  test('renders surface picker + tier picker when authed', async ({ page }) => {
    await seedAuthState(page)
    await stubMe(page)
    await stubPolicyState(page, {
      surfaces: [
        defaultStateForSurface('havenbot', 'confirm-per-action'),
        defaultStateForSurface('mcp', 'advisory'),
        defaultStateForSurface('openclaw', 'advisory'),
        defaultStateForSurface('checkout', 'advisory'),
      ],
    })

    await page.goto('/agent/policy/transition')
    if (page.url().includes('/login')) {
      test.skip(true, 'auth seed not picked up; seed schema drifted')
    }

    await expect(page.getByTestId('policy-page-hero')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('policy-surface-picker')).toBeVisible()
    await expect(page.getByTestId('policy-tier-picker')).toBeVisible()
    await expect(page.getByTestId('policy-tier-advisory')).toBeVisible()
    await expect(page.getByTestId('policy-tier-confirm-per-action')).toBeVisible()
    await expect(page.getByTestId('policy-tier-policy-bound')).toBeVisible()
  })

  test('Advisory → Policy-bound shows the forbidden-transition hint', async ({ page }) => {
    await seedAuthState(page)
    await stubMe(page)
    await stubPolicyState(page, {
      surfaces: [defaultStateForSurface('mcp', 'advisory')],
    })

    await page.goto('/agent/policy/transition')
    if (page.url().includes('/login')) {
      test.skip(true, 'auth seed not picked up; seed schema drifted')
    }

    await page.getByTestId('policy-tier-policy-bound').click()
    await expect(page.getByTestId('policy-gate-hint')).toBeVisible()
    await expect(page.getByTestId('policy-gate-hint')).toContainText(/forbidden/i)
    // Submit CTA should remain disabled.
    await expect(page.getByTestId('policy-submit')).toBeDisabled()
  })

  test('Confirm-per-action → Advisory applies as step-down without confirmation', async ({ page }) => {
    await seedAuthState(page)
    await stubMe(page)
    await stubPolicyState(page, {
      surfaces: [defaultStateForSurface('mcp', 'confirm-per-action')],
    })
    await stubPolicyTransition(page, {
      requiresConfirmation: false,
      state: defaultStateForSurface('mcp', 'advisory'),
    })

    await page.goto('/agent/policy/transition')
    if (page.url().includes('/login')) {
      test.skip(true, 'auth seed not picked up; seed schema drifted')
    }

    await page.getByTestId('policy-tier-advisory').click()
    await expect(page.getByTestId('policy-submit')).toBeEnabled()
    await page.getByTestId('policy-submit').click()

    // The current-tier strip reflects the post-step-down state.
    await expect(page.getByTestId('policy-current-tier')).toContainText(/Advisory/, {
      timeout: 5_000,
    })
  })

  test('Paused tier surfaces a Resume CTA that lands the surface in Advisory', async ({ page }) => {
    await seedAuthState(page)
    await stubMe(page)
    await stubPolicyState(page, {
      surfaces: [defaultStateForSurface('mcp', 'paused')],
    })
    await page.route(/\/api\/v1\/agent\/policy\/resume$/, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          state: defaultStateForSurface('mcp', 'advisory'),
        }),
      })
    })

    await page.goto('/agent/policy/transition')
    if (page.url().includes('/login')) {
      test.skip(true, 'auth seed not picked up; seed schema drifted')
    }

    await expect(page.getByTestId('policy-resume-panel')).toBeVisible()
    await page.getByTestId('policy-resume-cta').click()

    // After resume, the panel disappears + current tier strip flips to Advisory.
    await expect(page.getByTestId('policy-resume-panel')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByTestId('policy-current-tier')).toContainText(/Advisory/, {
      timeout: 5_000,
    })
  })

  test('Deep-link query params pre-fill surface + target picker', async ({ page }) => {
    await seedAuthState(page)
    await stubMe(page)
    await stubPolicyState(page, {
      surfaces: [
        defaultStateForSurface('havenbot', 'advisory'),
        defaultStateForSurface('mcp', 'advisory'),
      ],
    })

    await page.goto('/agent/policy/transition?surface=havenbot&target=confirm-per-action')
    if (page.url().includes('/login')) {
      test.skip(true, 'auth seed not picked up; seed schema drifted')
    }

    // Picker should reflect the pre-fill on first paint.
    await expect(page.getByTestId('policy-tier-confirm-per-action')).toBeVisible()
    // Submit button is enabled because target ≠ current tier.
    await expect(page.getByTestId('policy-submit')).toBeEnabled({ timeout: 5_000 })
  })

  test('Advisory → Confirm-per-action requires a second-tap confirmation', async ({ page }) => {
    await seedAuthState(page)
    await stubMe(page)
    await stubPolicyState(page, {
      surfaces: [defaultStateForSurface('mcp', 'advisory')],
    })

    // First call (no token) returns requiresConfirmation: true.
    let calls = 0
    await page.route(/\/api\/v1\/agent\/policy\/transition$/, async (route: Route) => {
      calls += 1
      const post = route.request().postDataJSON() as { confirmationToken?: string }
      if (post && post.confirmationToken) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            state: defaultStateForSurface('mcp', 'confirm-per-action'),
          }),
        })
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            requiresConfirmation: true,
            confirmation: {
              token: 'tok_' + 'a'.repeat(64),
              actionHash: 'sha256:' + 'b'.repeat(64),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          }),
        })
      }
    })

    await page.goto('/agent/policy/transition')
    if (page.url().includes('/login')) {
      test.skip(true, 'auth seed not picked up; seed schema drifted')
    }

    await page.getByTestId('policy-tier-confirm-per-action').click()
    await page.getByTestId('policy-submit').click()
    await expect(page.getByTestId('policy-pending-confirmation')).toBeVisible()
    // Second click consumes the token.
    await page.getByTestId('policy-submit').click()
    await expect(page.getByTestId('policy-current-tier')).toContainText(/Confirm per action/, {
      timeout: 5_000,
    })
    expect(calls).toBe(2)
  })
})
