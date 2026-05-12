import { ApplicationHttpError } from '../../../core/errors.js';
import {
  CHECKOUT_SESSION_STATUS_VALUES,
  CheckoutSessionStatus,
} from '../../../domain/checkout/model/checkout-session.js';
import type { ICheckoutSessionRepository } from '../../../domain/checkout/repository/checkout-session.repository.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type {
  CheckoutStatsRange,
  CheckoutStatsResponseDto,
} from '../../dto/checkout/checkout.dto.js';

/**
 * Wave 4 §5 Path D — issuer-side aggregate stats for the dashboard card.
 *
 * Count-only by design — amount aggregation is structurally impossible
 * because `encPayload` is encrypted at rest behind a fragment key the
 * backend never sees. See `ISSUER_CHECKOUT_DASHBOARD_PLAN.md` §1.A
 * invariant 3.
 *
 * Returns total + per-status counts + conversion rate + day-bucketed
 * trend line. The day-bucket array is gap-filled (zero-counts for days
 * without sessions) so the frontend chart renders a continuous x-axis
 * without needing to fill gaps client-side.
 *
 * `conversionRate` is `settled / (total - cancelled-equivalent)` where
 * cancelled-equivalent = `expired` + `failed`. Mid-flight rows (pending /
 * funded / wrapped / purchased) count as "in progress" for the
 * denominator. Wave 5 may refine this to a cohort-shaped funnel once the
 * dashboard has real volume; today the simple rate is the right starting
 * shape.
 */

export interface GetIssuerStatsInput {
  issuerUserId: string;
  range?: CheckoutStatsRange;
  now?: Date;
}

export class GetIssuerStatsUseCase {
  constructor(
    private readonly sessionRepo: ICheckoutSessionRepository,
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(input: GetIssuerStatsInput): Promise<CheckoutStatsResponseDto> {
    const issuer = await this.userRepo.findById(input.issuerUserId);
    if (!issuer || issuer.role !== 'issuer' || issuer.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'Issuer onboarding required before checkout-stats read',
        { code: 'NOT_APPROVED_ISSUER' },
      );
    }

    const range = input.range ?? '7d';
    const now = input.now ?? new Date();
    const { since, until } = rangeBounds(range, now);

    const aggregateOpts: { since?: Date; until?: Date } =
      since ? { since, until } : { until };
    const { total, byStatus } = await this.sessionRepo.countByIssuerAndStatus(
      input.issuerUserId,
      aggregateOpts,
    );

    // Day-bucket range: for `all`, anchor to the oldest activity; for 7d
    // / 30d, the requested window. The repo returns only days with ≥1
    // event; we gap-fill UTC days so the chart x-axis stays continuous.
    const trendSince = since ?? new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
    const dailyRaw = await this.sessionRepo.countByIssuerAndDay(input.issuerUserId, {
      since: trendSince,
      until,
    });
    const daily = fillDailyBuckets(trendSince, until, dailyRaw);

    const settled = byStatus[CheckoutSessionStatus.Settled] ?? 0;
    const purchased = byStatus[CheckoutSessionStatus.Purchased] ?? 0;
    const denom = total;
    // Conversion = settled / total. We treat `purchased` as "in progress
    // toward settled" so it counts in the denominator but not the
    // numerator — same intent as a Stripe funnel where purchase is mid-
    // flight until backend reconciles.
    const conversionRate = denom > 0 ? roundTo4(settled / denom) : 0;
    void purchased; // reserved: future "purchased-or-settled" composite metric.

    return {
      range,
      total,
      byStatus: Object.fromEntries(
        CHECKOUT_SESSION_STATUS_VALUES.map((s) => [s, byStatus[s] ?? 0]),
      ),
      conversionRate,
      daily,
    };
  }
}

function rangeBounds(
  range: CheckoutStatsRange,
  now: Date,
): { since: Date | null; until: Date } {
  const until = now;
  if (range === 'all') return { since: null, until };
  const days = range === '7d' ? 7 : 30;
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  return { since, until };
}

function fillDailyBuckets(
  since: Date,
  until: Date,
  rows: ReadonlyArray<{ bucketMs: number; count: number }>,
): Array<{ bucketMs: number; count: number }> {
  const byBucket = new Map<number, number>(rows.map((r) => [r.bucketMs, r.count]));
  const out: Array<{ bucketMs: number; count: number }> = [];
  const start = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate());
  const end = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate());
  for (let d = start; d <= end; d += 24 * 60 * 60 * 1000) {
    out.push({ bucketMs: d, count: byBucket.get(d) ?? 0 });
  }
  return out;
}

function roundTo4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
