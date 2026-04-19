import { test, expect } from '@playwright/test'
import { BACKEND_URL } from '../../lib/env.js'

test.describe('backend health', () => {
  test('/health returns 200 with healthy dependencies', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/health`)
    expect(res.status()).toBe(200)
    const body = (await res.json()) as {
      status: string
      dependencies?: Record<string, { status: string }>
    }
    expect(body.status).toBe('ok')
    // Postgres + fhe-worker both expected healthy.
    if (body.dependencies) {
      for (const [name, dep] of Object.entries(body.dependencies)) {
        expect(dep.status, `${name} dependency not ok`).toBe('ok')
      }
    }
  })

  test('/api/v1/tokens returns a non-empty token list', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/api/v1/tokens`)
    expect(res.status()).toBe(200)
    const body = (await res.json()) as { tokens: Array<{ address: string; status: string }> }
    expect(Array.isArray(body.tokens)).toBe(true)
    expect(body.tokens.length, 'no tokens seeded in backend').toBeGreaterThan(0)
    expect(body.tokens.some((t) => t.status === 'active')).toBe(true)
  })

  test('/api/v1/demo/whitelist-self responds (not 503)', async ({ request }) => {
    // The endpoint is POST. A 503 response indicates DEMO_WHITELIST_PRIVATE_KEY
    // is missing on the homelab — a config-drift signal that only surfaces
    // after a redeploy. We don't care whether the response is 401 (auth
    // missing), 400 (malformed body), or 405 (method issue): any of those
    // means the endpoint exists and the env is wired. We only fail on 503.
    const res = await request.post(`${BACKEND_URL}/api/v1/demo/whitelist-self`, {
      data: {},
      failOnStatusCode: false,
    })
    expect(
      res.status(),
      '503 → DEMO_WHITELIST_PRIVATE_KEY missing on homelab; redeploy backend',
    ).not.toBe(503)
  })
})
