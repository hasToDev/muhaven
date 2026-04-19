import { roleTest as test, expect } from '../../lib/fixtures.js'
import { logout, isAuthenticated } from '../../lib/auth.js'

test.describe.configure({ mode: 'serial' })

/**
 * Regression guard for the "lazy wallet reconnect" memory. Hitting /login
 * must NOT trigger an automatic passkey prompt — the wallet address should
 * be restored lazily, and provider materialization waits until a write is
 * attempted.
 *
 * Uses `addInitScript` to inject the WebAuthn patch BEFORE any script runs
 * in each new document — a `page.evaluate` patch is lost on navigation,
 * so the /login page's scripts would fire WebAuthn calls before our patch
 * could see them.
 */
test('visiting /login fires no automatic passkey prompt within 5s', async ({
  investorPage: page,
}) => {
  test.setTimeout(60_000)

  await page.goto('/')
  if (await isAuthenticated(page)) {
    await logout(page)
  }

  // Bridge WebAuthn calls from every document back to this test.
  let webauthnAttempted = false
  await page.exposeFunction('__e2eTrackWebauthn', (source: string) => {
    webauthnAttempted = true
    console.log(`[e2e] webauthn attempted — source: ${source}`)
  })

  // Injected into every new document BEFORE any other script runs. Patches
  // navigator.credentials.get / .create to pipe any invocation back to Node.
  await page.addInitScript(() => {
    const origGet = navigator.credentials.get.bind(navigator.credentials)
    const origCreate = navigator.credentials.create.bind(navigator.credentials)
    // @ts-expect-error — injected binding
    const track = (s: string) => window.__e2eTrackWebauthn?.(s)
    navigator.credentials.get = async (...args) => {
      await track('get')
      return origGet(...args)
    }
    navigator.credentials.create = async (...args) => {
      await track('create')
      return origCreate(...args)
    }
  })

  await page.goto('/login')
  await page.waitForTimeout(5_000)

  expect(
    webauthnAttempted,
    'WebAuthn prompt fired automatically on /login — lazy-reconnect regressed',
  ).toBe(false)
})
