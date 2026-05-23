import { sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import { getEnv } from '../../../core/config.js';

/**
 * Wave 5 Option D · Commit 2 — pgcrypto column-level encrypt-at-rest
 * helpers for the `agent_scoped_sessions.enable_data` / `enable_sig`
 * columns.
 *
 * **Design**:
 *   - Writes pass cleartext (typically a `0x`-prefixed hex string) into
 *     `encryptedTextOrNull(...)`, which expands to a
 *     `pgp_sym_encrypt(cleartext::text, key::text)` SQL fragment Drizzle
 *     interpolates as a column value during INSERT / UPDATE.
 *   - Reads fetch the raw `bytea` column AND ask for `pgp_sym_decrypt(..)`
 *     in the SELECT projection via `decryptedTextProjection(...)`, which
 *     returns an aliased SQL fragment. The default repository reads
 *     EXCLUDE the encrypted columns entirely (Drizzle's `columns: {...}`
 *     filter) so a maintainer can't accidentally leak cleartext through
 *     `findFirst` / `findMany`.
 *
 * **Key handling**:
 *   - The symmetric key lives in `OPTION_D_C2_ENCRYPTION_KEY` (64 hex
 *     chars = 32 bytes; generated per-deploy via `openssl rand -hex 32`).
 *   - `requireEncryptionKey()` throws when the key is missing — every
 *     write attempt that touches `enable_data` / `enable_sig` MUST fail
 *     loud if the operator hasn't set the var. Silent cleartext writes
 *     would leak via raw SELECT past the redaction.
 *   - Reads via `decryptedTextProjection(...)` also require the key —
 *     missing key → the install-material subroute returns 503 (handled
 *     at the route layer).
 *
 * **Why pgcrypto (vs Node `crypto.createCipheriv`)**:
 *   - The brief explicitly mandates pgcrypto column-level (SecEng T-1).
 *   - DB-side encryption keeps the cleartext envelope tighter: a raw
 *     `pg_dump` produces an encrypted blob, not the cleartext-then-
 *     re-encrypted-by-app pattern.
 *   - Requires `CREATE EXTENSION IF NOT EXISTS pgcrypto` once per DB.
 *     `ensurePgcryptoExtension()` runs at backend boot (idempotent).
 *
 * **Threat model the encrypt-at-rest closes**:
 *   - Adversary with read-only DB access (lost backup, SQL injection in
 *     an unrelated route, ops-script over-broad SELECT) cannot pre-empt
 *     the user's install + revoke window. Without encryption, a leaked
 *     enableData + enableSig + permissionId + validatorNonce tuple lets
 *     the adversary submit the install UserOp themselves (the kernel
 *     accepts any caller paying gas), denying the user the ability to
 *     revoke before install. After the validator is on-chain the
 *     values are publicly visible on a block explorer; encrypt-at-rest
 *     only matters in the `enable_status='pending'` window.
 */

export const ENCRYPTION_KEY_ENV_VAR = 'OPTION_D_C2_ENCRYPTION_KEY';

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      `pgcrypto encrypt-at-rest requires ${ENCRYPTION_KEY_ENV_VAR} (32-byte hex). ` +
        'Generate via `openssl rand -hex 32`, set on the homelab + operator env, ' +
        '`docker compose up -d --no-deps --force-recreate backend` to re-read env_file. ' +
        'See development/DEV_WAVE_5/DEV_LOG.md (Option D · Commit 2 deploy steps).',
    );
    this.name = 'MissingEncryptionKeyError';
  }
}

/**
 * Read the configured key; throw `MissingEncryptionKeyError` if unset.
 * Callers route the throw into a 503 response at the HTTP layer when
 * the call site is a read; writes re-throw as 500 because a mint that
 * captured install material can NOT silently fall back to cleartext —
 * that would defeat the encrypt-at-rest property.
 */
export function requireEncryptionKey(): string {
  const env = getEnv();
  const key = env.OPTION_D_C2_ENCRYPTION_KEY;
  if (!key) {
    throw new MissingEncryptionKeyError();
  }
  return key;
}

/**
 * Returns `true` iff the encryption key is configured. Callers use this
 * to gate optional writes (mint use-case: include enableData only when
 * the operator has wired the key; the column stays NULL otherwise so
 * the mirror row still lands and the user can proceed to legacy Path C
 * deep-link).
 */
export function hasEncryptionKey(): boolean {
  return Boolean(getEnv().OPTION_D_C2_ENCRYPTION_KEY);
}

/**
 * Encrypt a cleartext string (typically a `0x`-prefixed hex) into a
 * `pgp_sym_encrypt(...)` SQL fragment Drizzle interpolates as a column
 * value. Returns `null` when the input is `null` — keeps the bytea
 * column NULL in that branch (matches the C2 brief's NULL-first
 * default for back-compat).
 *
 * Throws `MissingEncryptionKeyError` when `OPTION_D_C2_ENCRYPTION_KEY`
 * is unset AND the cleartext is non-null. Tests / callers that need
 * "skip encryption when no key" must pre-check via `hasEncryptionKey()`
 * and pass `null` instead.
 *
 * `::text` casts are explicit on both arguments — pgcrypto's
 * `pgp_sym_encrypt` is overloaded on the cleartext type, and an
 * implicit-cast path through Drizzle's parameter binding has been a
 * footgun on other projects (PG returns "function pgp_sym_encrypt(...)
 * is not unique" with parameter binders that drop the cast).
 */
export function encryptedTextOrNull(cleartext: string | null): SQL | null {
  if (cleartext === null) return null;
  const key = requireEncryptionKey();
  return sql`pgp_sym_encrypt(${cleartext}::text, ${key}::text)`;
}

/**
 * Build a `pgp_sym_decrypt(...)` projection over a bytea column with a
 * stable alias. The caller uses it inside a Drizzle `db.execute(sql\`
 * SELECT ${decryptedTextProjection(col, 'alias')}, ...\`)` raw-SELECT
 * path; relational queries (`findFirst`) can't easily compose this so
 * the install-material subroute uses raw SQL.
 *
 * `CASE WHEN col IS NULL THEN NULL ELSE pgp_sym_decrypt(col, key) END`
 * keeps the NULL branch zero-cost (pgp_sym_decrypt of NULL throws);
 * the alias is interpolated raw via `sql.raw(...)` because column
 * aliases can't be parameterized.
 */
export function decryptedTextProjection(col: AnyColumn, alias: string): SQL {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    // Belt-and-braces — alias is internal but a typo'd value here
    // would corrupt the projection. Reject at the helper boundary.
    throw new Error(`decryptedTextProjection: invalid SQL identifier alias "${alias}"`);
  }
  const key = requireEncryptionKey();
  // Wave 5 Option D · Commit 2 — `pgp_sym_decrypt(bytea, text)` returns
  // `text` per the pgcrypto docs, but the explicit `::text` cast is
  // defensive against pg-driver type-coercion ambiguity AND mirrors the
  // `::text` cast on the encrypt side (`encryptedTextOrNull`).
  // Multi-agent review HIGH absorbed: Codex H-1 + SecEng H-1.
  return sql`CASE WHEN ${col} IS NULL THEN NULL ELSE pgp_sym_decrypt(${col}, ${key}::text)::text END AS ${sql.raw(alias)}`;
}

/**
 * Idempotent `CREATE EXTENSION IF NOT EXISTS pgcrypto`. Called once at
 * backend boot from `dev-server.ts`. Postgres requires the role to own
 * the DB or be superuser; the homelab `muhaven` user owns the muhaven
 * DB so this succeeds without an additional `\connect` ceremony.
 *
 * Throws on failure so the operator notices at boot. The repository
 * write path would otherwise surface a `42883 function pgp_sym_encrypt
 * does not exist` at first mint — much harder to triage in prod.
 */
export async function ensurePgcryptoExtension(
  exec: (q: SQL) => Promise<unknown>,
): Promise<void> {
  await exec(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
}
