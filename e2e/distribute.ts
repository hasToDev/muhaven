/**
 * e2e/distribute.ts
 *
 * Playwright-driven click-through of the deployed MuHaven DistributePage on
 * Arb Sepolia. Uses a persistent browser profile so the passkey survives
 * between runs. Pauses for the user to confirm biometric prompts and to run
 * setup-e2e on a fresh smart account address.
 *
 * See ./README.md for full usage.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { createPublicClient, http } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://muhaven.hasto.dev';
const AMOUNT = process.env.E2E_AMOUNT ?? '0.5';
const PASSKEY_NAME = process.env.E2E_PASSKEY_NAME ?? 'E2E Test Key';
const RPC_URL = process.env.ARB_SEPOLIA_RPC_URL ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const YIELD_DISTRIBUTOR_ADDRESS = '0xD403252436e41EFd81D76eB9223485cB66cb1638' as const;
const USER_DATA_DIR = path.join(__dirname, '.playwright-profile');
const TRACE_DIR = path.join(__dirname, 'trace');
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

const DISTRIBUTOR_ABI = [
  {
    name: 'distributionCount',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

async function prompt(question: string): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question(question);
  rl.close();
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

async function readDistributionCount(): Promise<bigint> {
  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC_URL) });
  return client.readContract({
    address: YIELD_DISTRIBUTOR_ADDRESS,
    abi: DISTRIBUTOR_ABI,
    functionName: 'distributionCount',
  });
}

async function isLoggedIn(page: Page): Promise<boolean> {
  // TopNav wallet pill renders the truncated address after auth. Heuristic:
  // wait a short time for either a 0x... address or the login form.
  const addressLocator = page.getByText(/0x[a-fA-F0-9]{4}\.\.\./).first();
  try {
    await addressLocator.waitFor({ state: 'visible', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

async function extractSmartAccountAddress(page: Page): Promise<string> {
  const addressText = await page.getByText(/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/).first().textContent();
  if (!addressText) throw new Error('Could not find smart account address in TopNav');
  return addressText.trim();
}

async function doRegister(page: Page): Promise<string> {
  console.log('\n→ Register mode: switching to Create Account flow');
  // LoginPage opens in "login" mode by default. Toggle to register.
  const toggle = page.getByRole('button', { name: /New here\? Create account/i });
  if (await toggle.isVisible({ timeout: 2000 }).catch(() => false)) {
    await toggle.click();
  }

  // Pick issuer role — DistributePage is issuer-side, and registering as
  // investor puts the user on a path that's semantically wrong for this test.
  // The role toggle is a styled button group (not a native radio), so we pick
  // by accessible name.
  console.log('→ Selecting issuer role');
  await page.getByRole('button', { name: /^\s*issuer\s*$/i }).click({ force: true });

  await page.getByPlaceholder(/My MuHaven key/i).fill(PASSKEY_NAME);
  // force:true for the same MButton-hover-transition reason (see below).
  await page.getByRole('button', { name: /Create Account/i }).click({ force: true });

  console.log('\n⏸  CONFIRM THE PASSKEY PROMPT (OS biometric dialog — Windows Hello / Touch ID / etc.)');
  console.log('   After you confirm, the "Demo mode — self-serve KYC" banner should appear.\n');

  // Wait for the demo banner to appear
  await page.getByText(/Demo mode — self-serve KYC/i).waitFor({ state: 'visible', timeout: 120_000 });

  console.log('→ Clicking "Enable demo access" to whitelist this address');
  // force:true skips Playwright's stability checks. MButton has
  // hover/active CSS scale transitions that cause the stability check to
  // retry-loop forever (and during the loop the post-click `authStep = done`
  // transition removes the button from DOM, so Playwright reports
  // "detached" even though the click actually landed).
  await page
    .getByRole('button', { name: /Enable demo access/i })
    .click({ force: true });

  // Wait for redirect to dashboard (indicates whitelist success + redirect).
  // Issuer role redirects to /tokens; investor redirects to /portfolio. Allow both
  // so the script works regardless of role toggle.
  await page.waitForURL(/\/(portfolio|tokens)/, { timeout: 120_000 });
  console.log('✓ Whitelisted + redirected to dashboard');

  const address = await extractSmartAccountAddress(page);
  return address;
}

async function doLogin(page: Page): Promise<void> {
  console.log('\n→ Login mode: signing in with existing passkey');
  // LoginPage opens in "login" mode by default. Verify we're there.
  const loginButton = page.getByRole('button', { name: /Sign In/i }).first();
  await loginButton.waitFor({ state: 'visible', timeout: 5000 });
  await loginButton.click({ force: true });

  console.log('\n⏸  CONFIRM THE PASSKEY PROMPT (OS biometric dialog)\n');
  await page.waitForURL(/\/(portfolio|tokens)/, { timeout: 120_000 });
  console.log('✓ Signed in');
}

async function driveDistribute(page: Page, amount: string): Promise<string | null> {
  console.log(`\n→ Navigating to /distribute`);
  await page.goto(new URL('/distribute', BASE_URL).toString());

  // If not issuer, the role switcher re-auths. DistributePage is issuer-only.
  // Wait for the page to render its token select.
  const tokenSelect = page.locator('select').first();
  await tokenSelect.waitFor({ state: 'visible', timeout: 15000 });

  // Pick the first non-placeholder option.
  const optionValues = await tokenSelect.locator('option').evaluateAll((opts) =>
    opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v && v !== ''),
  );
  if (optionValues.length === 0) {
    throw new Error('No tokens available in DistributePage token select — did setup-e2e run?');
  }
  await tokenSelect.selectOption(optionValues[0]);
  console.log(`→ Selected token: ${optionValues[0]}`);

  // Fill the amount input. LoginPage / DepositPage pattern uses a numeric-looking input.
  const amountInput = page.locator('input[type="number"], input[inputmode="decimal"]').first();
  await amountInput.fill(amount);
  console.log(`→ Amount: ${amount} PUSDC`);

  await screenshot(page, '01-pre-submit');

  console.log('\n⏸  CLICKING DISTRIBUTE — expect ~5 biometric prompts.');
  console.log('   UserOps: (setOperator if first time) → startDistribution → batchCreate → setEscrowIds → processBatch\n');

  const submitButton = page.getByRole('button', { name: /Distribute Yield/i }).first();
  await submitButton.click({ force: true });

  // Wait for either the success or failure receipt. Both have distinctive headers
  // inside the main MCard — scope to the card to avoid matching toast duplicates
  // (vue-sonner also surfaces the "Distribution Failed" text in a toast node).
  const successLocator = page.locator('p:has-text("Distribution Complete")').first();
  const failureLocator = page.locator('p:has-text("Distribution Failed")').first();

  await Promise.race([
    successLocator.waitFor({ state: 'visible', timeout: 600_000 }),
    failureLocator.waitFor({ state: 'visible', timeout: 600_000 }),
  ]);

  if (await failureLocator.isVisible().catch(() => false)) {
    await screenshot(page, '02-failure');
    // The failure card renders `<p>Distribution Failed</p>` then `<p>{reason}</p>`
    // as siblings. Walk up one level to grab both.
    const errorCard = await failureLocator.locator('..').innerText();
    throw new Error(`DistributePage reported failure:\n${errorCard}`);
  }

  // Success: parse the distribution ID from the `#{id}` row.
  const idRow = page.locator('text=/Distribution ID/i').first().locator('..');
  const idText = await idRow.innerText();
  await screenshot(page, '02-post-submit');

  const match = idText.match(/#(\d+)/);
  const id = match ? match[1] : null;
  console.log(`✓ Distribution #${id ?? '(unparsed)'} — receipt visible`);
  return id;
}

async function main(): Promise<void> {
  await mkdir(USER_DATA_DIR, { recursive: true });
  await mkdir(TRACE_DIR, { recursive: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  MuHaven E2E — DistributePage live-testnet click-through');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Base URL:       ${BASE_URL}`);
  console.log(`  Amount:         ${AMOUNT} PUSDC`);
  console.log(`  Profile dir:    ${USER_DATA_DIR}`);
  console.log(`  RPC:            ${RPC_URL}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const distCountBefore = await readDistributionCount();
  console.log(`→ Pre-test distributionCount: ${distCountBefore}`);

  const context: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
  });
  // Default Playwright timeout is 30s. Real-flow actions on this app wait on
  // on-chain txs + bundler inclusion + biometric prompts, all well beyond 30s.
  // Single knob for all actions unless overridden per-call. Slow UserOp chains
  // (Distribute) already carry their own longer waits.
  context.setDefaultTimeout(120_000);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  try {
    const page = await context.newPage();
    await page.goto(new URL('/', BASE_URL).toString());

    // If already authenticated from a previous run, the router sends us to /portfolio or /tokens.
    // Otherwise we land on / (landing) or /login.
    const alreadyAuthed = await isLoggedIn(page);

    if (!alreadyAuthed) {
      // Go to login explicitly
      await page.goto(new URL('/login', BASE_URL).toString());
      // Decide register vs login based on whether the profile already has a passkey.
      // Heuristic: if we're first-time (fresh profile), pick register. Otherwise login.
      // Since we can't introspect WebAuthn state, prefer register on fresh profile
      // (ZeroDev's passkey server will 409 if we try to register a duplicate — caller
      // should delete .playwright-profile to re-register).
      const profileIsFresh = !process.env.E2E_SKIP_REGISTER;

      if (profileIsFresh) {
        const smartAddress = await doRegister(page);
        console.log(`\n✓ Smart account address: ${smartAddress}`);
        console.log('\n═══════════════════════════════════════════════════════════════════');
        console.log('  ⏸  HANDOFF: run setup-e2e on the deployer side');
        console.log('═══════════════════════════════════════════════════════════════════');
        console.log(`  cd <repo-root>`);
        console.log(`  E2E_ADDRESS=${smartAddress} pnpm run setup:e2e`);
        console.log('═══════════════════════════════════════════════════════════════════');
        await prompt('\n  Press Enter here once setup-e2e completes successfully... ');
      } else {
        await doLogin(page);
      }
    } else {
      console.log('→ Profile already authenticated — skipping login step');
    }

    const distributionId = await driveDistribute(page, AMOUNT);

    // On-chain verification
    const distCountAfter = await readDistributionCount();
    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log('  Results');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  distributionCount before: ${distCountBefore}`);
    console.log(`  distributionCount after:  ${distCountAfter}`);
    console.log(`  delta:                    ${distCountAfter - distCountBefore}`);
    console.log(`  receipt distribution id:  ${distributionId ?? '(not parsed)'}`);
    console.log('═══════════════════════════════════════════════════════════════════');

    if (distCountAfter <= distCountBefore) {
      throw new Error(
        'distributionCount did not increase — distribute may have rendered a receipt but the on-chain tx did not land.',
      );
    }

    console.log('\n✓ E2E SUCCESS — distribute pipeline landed on Arb Sepolia\n');
  } finally {
    await context.tracing.stop({ path: path.join(TRACE_DIR, 'distribute.zip') });
    await context.close();
    console.log(`Trace saved to ${path.join(TRACE_DIR, 'distribute.zip')}`);
    console.log(`Screenshots saved to ${SCREENSHOT_DIR}`);
  }
}

main().catch((err) => {
  console.error('\n❌ E2E failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
