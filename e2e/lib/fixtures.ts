import { test as base, chromium } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROFILES_ROOT = path.resolve(__dirname, '..', 'profiles')

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function launchRoleContext(role: 'investor' | 'issuer'): Promise<BrowserContext> {
  const profileDir = path.join(PROFILES_ROOT, role)
  await ensureDir(profileDir)
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
  })
  // Every action that waits on biometric confirmation or bundler inclusion
  // can run well past the default 30s, so we bump the per-action timeout
  // across the board. Individual tests still guard against runaway waits
  // via `test.setTimeout(0)` or explicit `locator.waitFor(timeout)`.
  ctx.setDefaultTimeout(180_000)
  return ctx
}

type RoleFixtures = {
  investorContext: BrowserContext
  investorPage: Page
  issuerContext: BrowserContext
  issuerPage: Page
}

/**
 * Worker-scoped fixtures: one persistent context per role, reused across all
 * tests in the worker. With `workers: 1`, this is "one context per role, for
 * the whole suite run" — so the passkey registered once survives every test.
 *
 * A test that needs a fresh profile (e.g. register-investor.spec.ts) should
 * deliberately `rm -rf profiles/investor` before the suite starts — the
 * fixture will then create an empty profile.
 */
export const roleTest = base.extend<RoleFixtures>({
  investorContext: [
    async ({}, use) => {
      const ctx = await launchRoleContext('investor')
      await use(ctx)
      await ctx.close()
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  investorPage: async ({ investorContext }, use) => {
    const existing = investorContext.pages()[0]
    const page = existing ?? (await investorContext.newPage())
    await use(page)
  },
  issuerContext: [
    async ({}, use) => {
      const ctx = await launchRoleContext('issuer')
      await use(ctx)
      await ctx.close()
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  issuerPage: async ({ issuerContext }, use) => {
    const existing = issuerContext.pages()[0]
    const page = existing ?? (await issuerContext.newPage())
    await use(page)
  },
})

export { expect } from '@playwright/test'
