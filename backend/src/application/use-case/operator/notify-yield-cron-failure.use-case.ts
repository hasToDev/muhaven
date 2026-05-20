import { getLogger } from '../../../core/logger.js';
import type { IOperatorAlertTransport } from '../../../infrastructure/operator/operator-alert-transport.js';
import {
  sanitizeAlertContext,
  type SanitizeAlertInput,
} from './sanitize-alert-context.js';

function lg() {
  return getLogger('notify-yield-cron-failure');
}

export interface NotifyYieldCronFailureInput {
  err: unknown;
  tokenSymbol: string;
  tokenAddress?: string;
  epochId?: bigint;
  /** Defaults to `'error'`. The cron emits `'warn'` for soft-skip
   *  conditions (NAV stale > STALE_NAV_DAYS but ≤ HALT_DAYS, mhUSDC
   *  float below 7-day buffer); `'error'` for everything else. */
  severity?: 'info' | 'warn' | 'error';
}

/**
 * Wave 5 Q3 (step 3, plan C.4) — single entry point the cron's catch
 * handler invokes. Composes the sanitizer + the configured transport.
 *
 * Fire-and-forget semantics: the use case awaits the transport but
 * swallows its rethrow. The transport itself is already a swallow-
 * everything HTTP wrapper (`HttpOperatorAlertTransport.notify` catches
 * its own errors), but a future transport (multi-recipient fan-out,
 * say) might re-throw — this layer is the final firewall before the
 * cron's tick loop sees the exception. A Telegram outage MUST NOT cause
 * the cron to stop iterating across the remaining tokens.
 *
 * The use case is intentionally thin — sanitisation + dispatch only.
 * Cron-side context (which tick triggered it, dry-run state, etc.) lives
 * in the cron's structured log call alongside this. The Telegram alert
 * is a SECOND surface meant for an operator's phone; the primary audit
 * trail is the pino log + the `yield_distributions` audit row.
 *
 * Step-4 callers MUST pass `tokenAddress` whenever known (Round-1
 * Security M-4 — without it, every 40-hex string in the runner's error
 * message gets redacted to `0x…addr`, so operators lose the
 * symbol-↔-address correlation that the runner's six error classes
 * embed in `.message`). The cron has the address in scope at the catch
 * boundary; this is operator-actionability, not security — but if the
 * cron forgets to pass it, alerts read as `Token: USYC` + opaque body.
 */
export class NotifyYieldCronFailureUseCase {
  constructor(private readonly transport: IOperatorAlertTransport) {}

  async execute(input: NotifyYieldCronFailureInput): Promise<void> {
    const sanitizeInput: SanitizeAlertInput = {
      err: input.err,
      tokenSymbol: input.tokenSymbol,
      ...(input.tokenAddress !== undefined ? { tokenAddress: input.tokenAddress } : {}),
      ...(input.epochId !== undefined ? { epochId: input.epochId } : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
    };
    const payload = sanitizeAlertContext(sanitizeInput);
    try {
      await this.transport.notify(payload);
    } catch (transportErr) {
      lg().warn(
        {
          err: transportErr instanceof Error ? transportErr.message : String(transportErr),
          tokenSymbol: payload.tokenSymbol,
          errorClass: payload.errorClass,
        },
        'operator alert transport rethrew — alert dropped',
      );
    }
  }
}
