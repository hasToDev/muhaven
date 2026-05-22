/**
 * Postgres error-code helpers — narrow + driver-agnostic detection of
 * specific SQL state codes so use-cases can map them to friendly HTTP
 * responses without grepping magic strings.
 *
 * **Why this exists:** the application currently uses Drizzle on
 * node-postgres which exposes `pg.DatabaseError` with `.code` at the
 * top level. But Drizzle has wrapped errors in past major-version
 * upgrades (`DrizzleQueryError` with `.cause` carrying the raw pg
 * error). A use-case catch that reads `err.code` directly would
 * silently mis-route the loser of a race into a generic 500 if the
 * wrapping ever happens. This helper walks the most common
 * unwrap-chain locations.
 *
 * R2 Software Architect H-1 + Backend Architect M-1 round 2 — codified
 * here to also displace the 8+ magic-string `'23505'` occurrences across
 * the codebase.
 */

/**
 * SQL state codes (Postgres). Subset that the application actively
 * discriminates on. Add new codes here as use-cases need them — keep
 * the list narrow (we only document what's actually consumed).
 *
 * Full reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const PG_ERROR_CODES = {
  /** Class 23 — Integrity Constraint Violation. UNIQUE / partial-UNIQUE
   *  constraint hit on INSERT or UPDATE. Used by mint-scoped-session
   *  use-case at step 5b to catch the loser of the concurrent-mint race
   *  and re-emit as a friendly 409 with the winner's sessionId. */
  UNIQUE_VIOLATION: '23505',
} as const;

/**
 * Walks the most common unwrap-chain to extract the SQL state code from
 * an unknown error value. Returns `undefined` when the input doesn't
 * carry one. Inspects (in order):
 *
 *   1. `err.code`           — node-postgres + raw drizzle today
 *   2. `err.cause.code`     — DrizzleQueryError wrap shape (future)
 *   3. `err.driverError.code` — alternative wrap (future-proofing)
 *
 * Type-safe against `null` / `undefined` / non-object inputs.
 */
export function extractPgErrorCode(err: unknown): string | undefined {
  if (err === null || err === undefined || typeof err !== 'object') return undefined;
  const candidates: unknown[] = [
    (err as { code?: unknown }).code,
    (err as { cause?: { code?: unknown } }).cause?.code,
    (err as { driverError?: { code?: unknown } }).driverError?.code,
  ];
  for (const c of candidates) {
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/**
 * `true` when `err` (or any of its standard wrap parents) carries the
 * `23505` (unique_violation) SQL state code. Caller uses this to
 * discriminate a "lost the race + winner inserted" scenario from any
 * other DB failure that must bubble up as 500.
 */
export function isPgUniqueViolation(err: unknown): boolean {
  return extractPgErrorCode(err) === PG_ERROR_CODES.UNIQUE_VIOLATION;
}
