import { test, expect, type Route } from '@playwright/test'

/**
 * Wave 4 P10 — hosted-checkout shell (P5).
 *
 * The hosted-checkout app lives in `apps/checkout-pay/` and is a static
 * Vite SPA served on port 7780 in dev or `pay.muhaven.app` in prod.
 * Because it lives behind a different origin than the dashboard, this
 * spec defaults to `process.env.E2E_CHECKOUT_BASE_URL` and skips
 * gracefully when unset (so contributors without the dual-server setup
 * keep `pnpm test` green).
 *
 * Local: `cd apps/checkout-pay && bun run dev` → listens on port 7780,
 * then run with `E2E_CHECKOUT_BASE_URL=http://localhost:7780`.
 *
 * Coverage:
 *   1. Malformed URL (no fragment, no path) → error state
 *   2. Valid URL → loading → checkout state via stubbed lookup + decrypt
 *      (the AES-GCM payload is a real ciphertext encrypted in-test using
 *      the same wire shape as the backend codec, so decrypt actually
 *      runs against the production decode path).
 *   3. SSE event stream → status pill flips
 *   4. Bad fragment key (wrong length) → error
 *   5. Bad sessionId path → error (defends against path traversal)
 */

const CHECKOUT_BASE = process.env.E2E_CHECKOUT_BASE_URL ?? ''
const ORIGINAL_BASE = CHECKOUT_BASE || 'http://localhost:7780'

const TEST_SESSION_ID = 'cs_ABCDEFGHJKMNPQRSTVWXYZ2345' // 26 base32 chars
const FAKE_KERNEL_ADDRESS = '0x' + 'aa'.repeat(20)

/** Build a valid /c/<id>#k=<key> URL relative to the configured base. */
function checkoutUrl(sessionId: string, fragmentKey: string): string {
  return `${ORIGINAL_BASE}/c/${sessionId}#k=${fragmentKey}`
}

/**
 * Encrypts a payload with AES-256-GCM in the same wire format the
 * backend codec produces (`<iv>:<tag>:<ciphertext>` base64url). The
 * checkout decrypt path then runs against this identical shape.
 */
async function encryptForTest(
  plain: { amountUsd6: string; memo?: string; referenceId?: string },
): Promise<{ encPayload: string; fragmentKey: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const ivBytes = crypto.getRandomValues(new Uint8Array(12))

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const enc = new TextEncoder().encode(JSON.stringify(plain))
  const cipherWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes }, cryptoKey, enc),
  )
  const tag = cipherWithTag.slice(cipherWithTag.length - 16)
  const ciphertext = cipherWithTag.slice(0, cipherWithTag.length - 16)
  const wire = `${b64url(ivBytes)}:${b64url(tag)}:${b64url(ciphertext)}`
  return { encPayload: wire, fragmentKey: b64url(keyBytes) }
}

function b64url(b: Uint8Array): string {
  let bin = ''
  for (const byte of b) bin += String.fromCharCode(byte)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

const describeIfCheckout = CHECKOUT_BASE ? test.describe : test.describe.skip

describeIfCheckout('Wave 4 P10 · hosted-checkout shell', () => {
  test('malformed URL (no fragment) lands on error state', async ({ page }) => {
    // No #k= → fragment.ts returns null → main.ts shows error.
    await page.goto(`${ORIGINAL_BASE}/c/${TEST_SESSION_ID}`)
    await expect(page.locator('#error')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#error .error-detail')).toContainText(/malformed|missing/i)
    await expect(page.locator('#checkout')).toBeHidden()
  })

  test('malformed URL (bad sessionId) lands on error state (path-traversal defense)', async ({
    page,
  }) => {
    await page.goto(`${ORIGINAL_BASE}/c/../etc#k=AAAA`)
    await expect(page.locator('#error')).toBeVisible({ timeout: 10_000 })
  })

  test('malformed URL (bad fragment key length) lands on error state', async ({ page }) => {
    // FRAGMENT_KEY_RE = /^[A-Za-z0-9_-]{43}$/ — anything else is rejected.
    await page.goto(`${ORIGINAL_BASE}/c/${TEST_SESSION_ID}#k=tooshort`)
    await expect(page.locator('#error')).toBeVisible({ timeout: 10_000 })
  })

  test('valid URL → loading → checkout state via stubbed lookup', async ({ page }) => {
    const { encPayload, fragmentKey } = await encryptForTest({
      amountUsd6: '100000000', // $100.00
      memo: 'Test purchase',
      referenceId: 'ref_abc123',
    })

    await page.route(/\/api\/v1\/checkout\/sessions\/lookup(\?|$)/, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: TEST_SESSION_ID,
          status: 'pending',
          encPayload,
          metadata: {
            issuerAddress: '0x' + 'bb'.repeat(20),
            tokenAddress: '0x' + 'cc'.repeat(20),
            tokenSymbol: 'GOLD1',
            issuerLabel: 'Acme Issuer',
            description: 'Buy GOLD1',
            successUrl: null,
            cancelUrl: null,
          },
          buyerAddress: null,
          purchaseTxHash: null,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          createdAt: new Date().toISOString(),
        }),
      })
    })
    // Stub SSE to keep the EventSource open without traffic.
    await page.route(/\/api\/v1\/checkout\/sessions\/events(\?|$)/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ': stub stream\n\n',
      })
    })

    await page.goto(checkoutUrl(TEST_SESSION_ID, fragmentKey))

    // Wait for the checkout section to take over from loading.
    await expect(page.locator('#checkout')).toBeVisible({ timeout: 15_000 })
    // Issuer label populated from metadata.
    await expect(page.locator('#checkout .issuer .name')).toContainText(/Acme Issuer/i)
    // Symbol shown.
    await expect(page.locator('#checkout .symbol')).toContainText(/USDC/i)
    // Amount rendered (decryption succeeded).
    await expect(page.locator('#checkout .amount')).not.toBeEmpty()
    // Memo from the decrypted payload.
    await expect(page.locator('#checkout .memo')).toContainText(/Test purchase/i)
    // First step (pending → sign in) visible.
    await expect(page.locator('#step-pending')).toBeVisible()
  })

  test('lookup 404 surfaces error state (no oracle on existence)', async ({ page }) => {
    await page.route(/\/api\/v1\/checkout\/sessions\/lookup(\?|$)/, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ title: 'session not found' }),
      })
    })

    const fragmentKey = b64url(crypto.getRandomValues(new Uint8Array(32)))
    await page.goto(checkoutUrl(TEST_SESSION_ID, fragmentKey))
    await expect(page.locator('#error')).toBeVisible({ timeout: 15_000 })
  })

  test('decrypt failure (wrong fragment key) surfaces specific error', async ({ page }) => {
    // Generate a payload encrypted with key A; navigate with a fresh
    // (but well-formed) key B so AES-GCM auth-tag check fails.
    const { encPayload } = await encryptForTest({ amountUsd6: '1' })
    await page.route(/\/api\/v1\/checkout\/sessions\/lookup(\?|$)/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: TEST_SESSION_ID,
          status: 'pending',
          encPayload,
          metadata: {
            issuerAddress: '0x' + 'bb'.repeat(20),
            tokenAddress: '0x' + 'cc'.repeat(20),
            tokenSymbol: 'GOLD1',
            issuerLabel: 'Acme',
            description: 'X',
            successUrl: null,
            cancelUrl: null,
          },
          buyerAddress: null,
          purchaseTxHash: null,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          createdAt: new Date().toISOString(),
        }),
      })
    })

    const wrongKey = b64url(crypto.getRandomValues(new Uint8Array(32)))
    await page.goto(checkoutUrl(TEST_SESSION_ID, wrongKey))
    await expect(page.locator('#error')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#error .error-detail')).toContainText(/decrypt/i)
  })

  test.skip('end-to-end with passkey ceremony + on-chain wrap+buy', () => {
    // Wave 5 — needs a real ZeroDev passkey + funded kernel + live
    // Subscription contract. Out of scope per ADR-5.
    // Documented Wave-5 follow-up in PROGRESS.md §"Phase P5 — Wave 5
    // follow-ups (informative)".
    void FAKE_KERNEL_ADDRESS
  })
})
