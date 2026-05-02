/**
 * Phase 9.A · Expansion (F2) — backfill `issuer_status` for existing
 * issuer-roled rows.
 *
 * Drizzle declarative push doesn't run data migrations, so the new
 * `issuer_status` column lands with the default `unregistered` for every
 * existing row — including the demo issuer rows that already shipped
 * tokens. This one-shot script flips all `role='issuer'` rows to
 * `issuer_status='approved'` (with `issuer_approved_at = createdAt`) so
 * the post-deploy LoginPage redirect doesn't bounce existing issuers
 * back to `/apply-issuer`.
 *
 * Idempotent: running twice is a no-op (only updates rows where
 * `issuer_status='unregistered'`). Safe to re-run after a fresh DB push.
 *
 * Usage (inside the staging container):
 *   docker compose -f docker-compose.stage.yml -p muhaven-stage exec -T backend \
 *     pnpm tsx scripts/backfill-issuer-status.ts
 */
import { eq, and } from 'drizzle-orm';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import { users } from '../src/infrastructure/repository/postgres/schema.js';

async function main() {
  const db = getDb();

  const candidates = await db
    .select({ id: users.id, walletAddress: users.walletAddress, createdAt: users.createdAt })
    .from(users)
    .where(and(eq(users.role, 'issuer'), eq(users.issuerStatus, 'unregistered')));

  if (candidates.length === 0) {
    console.log('[backfill-issuer-status] no issuer-roled rows in unregistered state — exiting');
    return;
  }

  console.log(`[backfill-issuer-status] flipping ${candidates.length} row(s) to approved:`);
  for (const c of candidates) {
    console.log(`  - ${c.walletAddress} (createdAt=${c.createdAt.toISOString()})`);
  }

  await db
    .update(users)
    .set({ issuerStatus: 'approved', issuerApprovedAt: new Date(0) })
    .where(and(eq(users.role, 'issuer'), eq(users.issuerStatus, 'unregistered')));

  // Backfill `issuer_approved_at` from `created_at` for parity with the
  // wizard happy path (it stamps `now()`). Use the row's createdAt rather
  // than a single fixed date so the timeline is approximately correct.
  for (const c of candidates) {
    await db
      .update(users)
      .set({ issuerApprovedAt: c.createdAt })
      .where(eq(users.id, c.id));
  }

  console.log('[backfill-issuer-status] done');
}

main().catch((err) => {
  console.error('[backfill-issuer-status] failed:', err);
  process.exitCode = 1;
});
