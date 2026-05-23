import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { container } from '../../../src/infrastructure/container.js';
import {
  createHandler,
  sendResponse,
} from '../../../src/interface/handler-factory.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { withServiceSecret } from '../../../src/interface/middleware/with-service-secret.js';
import { getLogger } from '../../../src/core/logger.js';
import { Response } from '../../../src/interface/response.js';

/**
 * POST /api/v1/operator/option-d-c1-revoke-all-active-scoped-sessions
 *
 * Wave 5 Option D · Commit 1 — one-shot operator-driven migration
 * endpoint. Fires `RevokeAllPreOptionDScopedSessionsUseCase` to flip
 * every `status='active'` row in `agent_scoped_sessions` to
 * `'revoked'` and emit one `ScopedSessionRevokedByPolicyMigration`
 * audit row per affected session.
 *
 * **When to invoke**: ONCE, immediately after the broadened on-chain
 * CallPolicy ships to prod. The pre-D1 narrow-policy snapshots
 * become unsafe to leave active because the broker's mirror auto-sync
 * (Slice 2.B) would otherwise let those rows continue to back the
 * broker keystore against an old permissionId.
 *
 * **Idempotency semantics** (CR-MED-2 / BA-HIGH-3, multi-agent
 * review 2026-05-23):
 *
 *   - Re-running on a clean DB (no active rows) is a 200 OK no-op
 *     with `revokedCount: 0` — safe to retry on transport blips.
 *   - **Re-running AFTER a partial-failure DOES NOT re-emit the
 *     orphaned audit rows.** The bulk UPDATE has already flipped
 *     every row to `revoked`; `revokeAllActive` then finds zero
 *     active rows on the second call. The orphaned mirror rows
 *     (status='revoked', no paired audit) must be reconciled
 *     manually via the operator runbook (grep `orphanMirrorRow:true`
 *     logs or SELECT against `agent_audit_events`).
 *
 * **Operator runbook on success**: after a successful run with
 * `revokedCount > 0`, ROTATE `OPTION_D_C1_MIGRATION_SECRET` on both
 * the homelab and operator machine. SecEng-HIGH-3 (multi-agent
 * review 2026-05-23) — the route is replayable indefinitely, and a
 * post-ceremony secret leak lets an attacker bulk-revoke every
 * future legitimate Scoped session. The endpoint's purpose is
 * one-shot; rotate-then-decommission the secret accordingly.
 *
 * **Auth**: shared service secret in `Authorization: Bearer <secret>`,
 * env var `OPTION_D_C1_MIGRATION_SECRET`. Dedicated env so a leak on
 * one operator surface (`OPERATOR_ALERT_TEST_SECRET`,
 * `TELEGRAM_BOT_SERVICE_SECRET`) doesn't grant access to the
 * migration surface. The shell wrapper script
 * `scripts/sql/option-d-c1-migration.sh` reads the secret from the
 * operator's local env and forwards via curl.
 *
 * **Method allowance**: POST only — the verb check sits INSIDE
 * `withServiceSecret` (matches `operator/alert-test.ts` round-2
 * API-Tester M-5) so an unauthenticated probe gets a uniform 401/503
 * across verbs and the route does not fingerprint itself to a scanner.
 *
 * **Deploy ordering** (BA-MED-9, multi-agent review 2026-05-23) —
 * the operator MUST run `bash scripts/db-push-homelab.sh` BEFORE
 * this route is called for the first time. The new audit enum
 * value `scoped_session_revoked_by_policy_migration` is shipped via
 * Drizzle declarative `db:push`; if the route is hit before
 * `db:push`, every per-row audit emission throws Pg `22P02
 * invalid_text_representation` and the use-case returns 500 with
 * `auditEmissionFailures === revokedCount` (every row flipped to
 * revoked, no audits emitted). That outcome is operator-visible
 * via the response payload + structured logs, but the broken state
 * is HARD to recover (mirror flipped, no audits — manual SQL is
 * the only path). Document this in the deploy runbook + verify
 * `db:push` ran successfully before invoking the script.
 *
 * **Body**: optional — leave empty for the canonical run. Tests +
 * operator overrides may set `reason` to record a custom string in
 * the audit metadata; defaults to `option_d_c1_callpolicy_widening`.
 */
const MigrationDtoSchema = z
  .object({
    /**
     * Optional override for the audit-metadata `reason` field.
     *
     * **Charset-restricted** (SecEng-HIGH-4, multi-agent review
     * 2026-05-23) — the value lands verbatim in `agent_audit_events
     * .metadata.reason`, which the Compliance dashboard + Telegram
     * forensic alerts read. Stored XSS / Trojan-Source-style
     * bidi-Unicode spoofing into a WORM forensic surface is
     * permanent (the audit table is append-only by contract; we
     * cannot UPDATE a poisoned row). The regex mirrors the shell
     * wrapper's client-side allowlist byte-for-byte. Length capped
     * at 128.
     */
    reason: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(
        /^[A-Za-z0-9_.:/\s-]+$/,
        'reason: only ASCII letters/digits/dot/colon/slash/underscore/dash/whitespace allowed (forensic-row safety)',
      )
      .optional(),
    /**
     * Optional cutoff — `agent_scoped_sessions.minted_at_sec` strictly
     * greater than this value will NOT be revoked.
     *
     * CR-MED-3 / BA-MED-5 (multi-agent review 2026-05-23) absorbed.
     * Default `undefined` → revoke every active row (the canonical
     * one-shot ceremony). Operator can pin to "everything minted
     * before the broadened-CallPolicy deploy" via the shell wrapper
     * `--cutoff` flag so a post-deploy mint slipped in by a user
     * between deploy + this call survives.
     */
    mintedBeforeSec: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();

const log = getLogger('OptionDC1Migration');

const handler = createHandler({
  operationName: 'OptionDC1RevokeAllActiveScopedSessions',
  schema: MigrationDtoSchema,
  execute: async (dto) => {
    try {
      const result = await container.revokeAllPreOptionDScopedSessions.execute({
        reason: dto.reason,
        mintedBeforeSec: dto.mintedBeforeSec,
      });
      log.info(
        {
          revokedCount: result.revokedCount,
          auditEmissionFailures: result.auditEmissionFailures,
          skippedOrphanedUserCount: result.skippedOrphanedUserIds.length,
          appliedAt: result.appliedAt.toISOString(),
          reason: dto.reason ?? 'option_d_c1_callpolicy_widening',
          mintedBeforeSec: dto.mintedBeforeSec ?? null,
        },
        'Option D · C1 migration succeeded.',
      );
      // SecEng-HIGH-3 operator-runbook nudge — surface the rotate-secret
      // step in operator logs whenever the migration actually flipped
      // rows. One-shot ceremony hygiene; the endpoint is otherwise
      // replayable indefinitely.
      if (result.revokedCount > 0) {
        log.warn(
          {
            revokedCount: result.revokedCount,
            appliedAt: result.appliedAt.toISOString(),
          },
          'Option D · C1 migration: post-success operator action REQUIRED — ROTATE `OPTION_D_C1_MIGRATION_SECRET` on both homelab and operator machine, then remove route in the follow-up cleanup commit.',
        );
      }
      // SecEng-MED-5 — return COUNTS only in the success path; full
      // orphan-id arrays remain in the 500 partial-failure response
      // where the operator legitimately needs them to reconcile.
      return Response.ok({
        ok: true,
        revokedCount: result.revokedCount,
        auditEmissionFailures: result.auditEmissionFailures,
        skippedOrphanedUserCount: result.skippedOrphanedUserIds.length,
        appliedAt: result.appliedAt.toISOString(),
      });
    } catch (err) {
      // Surface the partial-result payload to the operator so the
      // script's stderr carries enough context to reconcile without
      // SSH-into-homelab + grep. The use-case attaches
      // `partialResult` when the bulk update succeeded but per-row
      // audit emissions threw.
      const partial = (err as { partialResult?: unknown }).partialResult;
      const errCode = (err as { code?: unknown }).code;
      log.error(
        { err, partial, code: errCode },
        'Option D · C1 migration FAILED (mirror flipped, some audits orphaned).',
      );
      // 207 Multi-Status would be the semantically-correct verb for
      // "mirror flipped, audits partial"; we use a 500 with a
      // structured body so existing HTTP-error handling in the
      // operator script (curl --fail) trips visibly. Operators read
      // the JSON body for the orphan list.
      // BA-MED-8 — include `err.code` discriminator so future tooling
      // can branch on transient-partial vs unexpected-throw without
      // string-matching the detail field.
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Option D · C1 Migration Partial Failure',
          status: 500,
          code:
            typeof errCode === 'string'
              ? errCode
              : 'OPTION_D_C1_UNEXPECTED_FAILURE',
          detail: err instanceof Error ? err.message : String(err),
          partial: partial ?? null,
        }),
      };
    }
  },
});

const protectedHandler = withServiceSecret(
  {
    envVar: 'OPTION_D_C1_MIGRATION_SECRET',
    serviceName: 'Option D · C1 Migration',
  },
  async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== 'POST') {
      sendResponse(res, Response.methodNotAllowed('POST'));
      return;
    }
    return handler(req, res);
  },
);

export default withCors(protectedHandler);
