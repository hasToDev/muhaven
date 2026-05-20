import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { container } from '../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../src/interface/handler-factory.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { withServiceSecret } from '../../../src/interface/middleware/with-service-secret.js';
import { Response } from '../../../src/interface/response.js';

/**
 * POST /api/v1/operator/alert-test — Wave 5 Q3 (step 3, plan C.5)
 * boot-time sanity check.
 *
 * Sends a synthetic info-level alert through the live alert transport
 * end-to-end so the operator can confirm `OPERATOR_TELEGRAM_CHAT_ID`
 * resolves to the intended chat BEFORE flipping
 * `YIELD_CRON_DRY_RUN=false`. Catches the "pasted the wrong group id"
 * class of misconfig that would otherwise only surface on the first
 * real cron failure.
 *
 * Auth: shared service secret in `Authorization: Bearer <secret>`. The
 * operator script holds `OPERATOR_ALERT_TEST_SECRET`. Dedicated env
 * var (NOT `ORACLE_INGEST_SERVICE_SECRET`) so a leak on the oracle
 * ingest surface doesn't grant access to the operator-alert surface,
 * and vice versa.
 *
 * The route returns 200 + `{ ok: true }` even when the transport's
 * underlying delivery fails — same posture as
 * `HttpOperatorAlertTransport.notify`. The operator confirms delivery
 * by checking Telegram, NOT by the HTTP status code. A 200 + no
 * message landing in the operator's chat IS the diagnostic signal that
 * the chat-id env var is wrong.
 *
 * Method allowance: POST only — verb check is INSIDE `withServiceSecret`
 * (Round-2 API-Tester M-5) so an unauthenticated probe gets 401 or 503
 * uniformly across verbs, NOT 405 (which would fingerprint the route).
 * `OPTIONS` short-circuits inside `withCors` for the preflight path.
 *
 * Round-1 Code-Reviewer MED (deferred to step-4 runbook): when
 * `OPERATOR_ALERT_TEST_SECRET` is unset, `withServiceSecret` returns
 * 503 for ALL callers — including unauthenticated probes. Same posture
 * as `oracle/ingest.ts`; not a vulnerability but does leak the bool
 * "feature configured / not configured" to a scanner. Operator should
 * be aware. Documenting here rather than refactoring the middleware
 * (cross-route concern; the right place for a fix is `with-service-
 * secret.ts`).
 */

// Round-2 API-Tester M-6 — `.trim()` on the note so whitespace-only
// inputs (`"   "`) fail validation as empty instead of silently
// degrading to "alert with no meaningful note". `min(1)` post-trim
// catches the otherwise-accepted whitespace-only edge.
const AlertTestDtoSchema = z
  .object({
    /** Optional override; useful when the operator wants to test routing
     *  to a non-default chat without flipping the env var. Leave unset
     *  to fire with a synthesised ISO-8601 ping body. */
    note: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

class AlertTestPing extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlertTestPing';
  }
}

const handler = createHandler({
  operationName: 'OperatorAlertTest',
  schema: AlertTestDtoSchema,
  execute: async (dto) => {
    const tokenSymbol = 'CONFIG_TEST';
    const note = dto.note ?? `alert-test invoked at ${new Date().toISOString()}`;
    await container.notifyYieldCronFailure.execute({
      // Build a synthetic Error so the sanitiser whitelist exercises
      // the same paths it does on a real cron failure. The errorClass
      // is intentionally distinguishable from the runner's six classes
      // so the operator (and any log scraper) can tell a smoke ping
      // apart from a live alert.
      err: new AlertTestPing(note),
      tokenSymbol,
      severity: 'info',
    });
    // Round-2 API-Tester L-3 — surface which transport just fired so
    // the operator knows whether to expect a Telegram message
    // (`'http'`) or only a backend log entry (`'logging'`). Without
    // this, alert-test's diagnostic value drops sharply when one of
    // TELEGRAM_BOT_WORKER_URL / TELEGRAM_BOT_SERVICE_SECRET /
    // OPERATOR_TELEGRAM_CHAT_ID is missing — operator gets 200 and
    // checks Telegram, sees nothing, wonders if the bot is broken vs
    // the env is misconfigured.
    return Response.ok({
      ok: true,
      severity: 'info',
      tokenSymbol,
      transport: container.operatorAlertTransportKind,
    });
  },
});

// Round-2 API-Tester M-5 — verb check INSIDE `withServiceSecret`. An
// unauthenticated GET would otherwise return 405 (with `Allow: POST`)
// before the secret check, fingerprinting the route to a scanner that
// has no credential. Putting the verb check inside the protected wrap
// means an unauth GET returns 401/503 (uniform with all other verbs)
// and only an authenticated caller asking for the wrong verb sees 405.
const protectedHandler = withServiceSecret(
  { envVar: 'OPERATOR_ALERT_TEST_SECRET', serviceName: 'Operator Alert Test' },
  async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== 'POST') {
      sendResponse(res, Response.methodNotAllowed('POST'));
      return;
    }
    return handler(req, res);
  },
);

export default withCors(protectedHandler);
