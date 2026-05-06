import { test, expect, type Route } from '@playwright/test'
import { byTestId, SEL } from '../../lib/selectors.js'

/**
 * Wave 4 P10 — MCP device-code ceremony, browser-side.
 *
 * The full ceremony has three actors:
 *   1. `muhaven-broker` daemon (CLI process) — POSTs `/auth/device/code`,
 *      polls `/auth/device/token` until JWT lands. Tested by
 *      `packages/mcp/__tests__/{daemon-handler,backend-client}.test.ts`
 *      and the new PG integration suite at
 *      `backend/src/infrastructure/repository/postgres/__tests__/pg-agent-device-code.integration.test.ts`.
 *   2. The user's dashboard browser session — visits `/link?code=…`,
 *      reviews requesterMetadata, clicks Authorize, mints the JWT
 *      backend-side. **This is what the spec exercises.**
 *   3. The MCP host (Claude Desktop / Cursor / Claude Code) — receives
 *      JWT via broker keystore IPC + invokes tools over STDIO. Tested by
 *      `packages/mcp/__tests__/mcp-redteam.test.ts` (InMemoryTransport
 *      against the real `buildMcpServer` factory).
 *
 * What this spec does:
 *   - Drives the dashboard side of the ceremony with route stubs:
 *     simulate the broker request happening, then assert the dashboard
 *     posts the authorize request with the correct userCode + metadata
 *     surfacing.
 *   - Captures the authorize POST body and asserts the spec contract
 *     the backend depends on (no `deny:true` on the happy path; the
 *     request body matches the userCode displayed).
 *
 * What this spec does NOT do (out of scope per ADR-3):
 *   - Run the actual `muhaven-broker login` CLI ceremony (operator
 *     task per PROGRESS.md §"Phase P3 — operator tasks").
 *   - Spawn an MCP host process and verify a real tool call (covered
 *     by the unit-level redteam suite).
 */

interface RequesterMeta {
  processName: string
  hostname: string
  os: string
}

const BROKER_META: RequesterMeta = {
  processName: 'muhaven-broker',
  hostname: 'developer-laptop',
  os: 'darwin',
}

const CODE = 'JKLM-NPQR' // Crockford-clean

async function seedAuthState(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem(
        'muhaven:auth',
        JSON.stringify({
          isAuthenticated: true,
          accessToken: 'test.placeholder.jwt',
          user: { id: 'u_test', walletAddress: '0x' + 'aa'.repeat(20), role: 'investor' },
        }),
      )
    } catch {
      /* swallow */
    }
  })
}

test.describe('Wave 4 P10 · MCP device-code ceremony (browser side)', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuthState(page)
  })

  test('full happy path: lookup → idle → authorize → success with correct request body', async ({
    page,
  }) => {
    let lookupCalled = false
    let lookupCode: string | null = null
    let authorizePostBody: { deny?: boolean; userCode?: string } | null = null
    let authorizeCalled = false

    await page.route(/\/api\/v1\/auth\/device\/lookup(\?|$)/, async (route: Route) => {
      lookupCalled = true
      const url = new URL(route.request().url())
      lookupCode = url.searchParams.get('code') ?? url.searchParams.get('userCode')
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          requesterMetadata: BROKER_META,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      })
    })
    await page.route(/\/api\/v1\/auth\/device\/authorize(\?|$)/, async (route) => {
      authorizeCalled = true
      const text = route.request().postData()
      try {
        authorizePostBody = text ? JSON.parse(text) : null
      } catch {
        authorizePostBody = null
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ requesterMetadata: BROKER_META }),
      })
    })

    await page.goto(`/link?code=${CODE}`)

    await Promise.race([
      byTestId(page, SEL.linkPhaseIdle).waitFor({ state: 'visible', timeout: 10_000 }),
      page.waitForURL(/\/login/, { timeout: 10_000 }),
    ])
    if (page.url().includes('/login')) {
      test.skip(true, 'auth seed required for ceremony happy path')
    }

    // Lookup must have fired with the correct user code (case-folded).
    expect(lookupCalled).toBe(true)
    expect(lookupCode).toBe(CODE)

    // Requester meta surfaces match the broker's BROKER_META.
    await expect(byTestId(page, SEL.linkRequesterMeta)).toContainText(BROKER_META.processName)
    await expect(byTestId(page, SEL.linkRequesterMeta)).toContainText(BROKER_META.hostname)
    await expect(byTestId(page, SEL.linkRequesterMeta)).toContainText(BROKER_META.os)

    // Click Authorize. Backend should receive the userCode in the body.
    await byTestId(page, SEL.linkAuthorizeCta).click()
    await byTestId(page, SEL.linkPhaseSuccess).waitFor({ state: 'visible', timeout: 10_000 })

    expect(authorizeCalled).toBe(true)
    expect(authorizePostBody).not.toBeNull()
    // Don't pin the exact key (the dashboard may send `userCode` or `code`).
    // What's load-bearing is that:
    //   1. The body carries the same code the user is authorizing
    //   2. NOT a deny: true marker
    const carries =
      authorizePostBody?.userCode === CODE ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (authorizePostBody as any)?.code === CODE
    expect(carries).toBe(true)
    expect(authorizePostBody?.deny).not.toBe(true)
  })

  test('expired-window code error surfaces single error state (collapsed oracle)', async ({
    page,
  }) => {
    await page.route(/\/api\/v1\/auth\/device\/lookup(\?|$)/, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'invalid or expired code' }),
      })
    })

    await page.goto(`/link?code=${CODE}`)
    await Promise.race([
      byTestId(page, SEL.linkPhaseError).waitFor({ state: 'visible', timeout: 10_000 }),
      page.waitForURL(/\/login/, { timeout: 10_000 }),
    ])
    if (page.url().includes('/login')) {
      test.skip(true, 'auth seed required')
    }
    await expect(byTestId(page, SEL.linkErrorMessage)).toBeVisible()
  })

  test.skip('end-to-end with real broker CLI + MCP host process', () => {
    // Operator task per PROGRESS.md §"Phase P3 — operator tasks":
    // Manual end-to-end smoke test with a real `muhaven-broker login`
    // ceremony, a Claude Desktop install, and a live `muhaven.read.portfolio`
    // call. Cannot be auto-driven from CI.
  })
})
