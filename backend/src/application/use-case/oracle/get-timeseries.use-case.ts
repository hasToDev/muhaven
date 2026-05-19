import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import { ApplicationHttpError } from '../../../core/errors.js';

/**
 * Hard ceiling on a single response. USYC has the largest current
 * series (~5,700 points); 10,000 leaves headroom for the longest
 * realistic measure × ticker without inviting unbounded payloads
 * from cache-busted query fan-out. When a client legitimately needs
 * more, they must narrow with `from` / `to`.
 */
const MAX_POINTS = 10_000;

export interface OracleTimeseriesDto {
  ticker: string;
  measure_slug: string;
  from: string | null;
  to: string | null;
  count: number;
  points: Array<{ date: string; value: string; unit: string | null }>;
}

export interface GetTimeseriesInput {
  ticker: string;
  measure_slug: string;
  from?: string;
  to?: string;
}

export class GetTimeseriesUseCase {
  constructor(private readonly oracleRepo: IOracleRepository) {}

  async execute(input: GetTimeseriesInput): Promise<OracleTimeseriesDto> {
    if (input.from && input.to && input.from > input.to) {
      throw ApplicationHttpError.badRequest(
        `'from' (${input.from}) must be <= 'to' (${input.to})`,
      );
    }

    // 404 when ticker isn't in the catalog so callers can distinguish
    // "unknown token" from "known token, no points in this range."
    // Mirrors the metadata + snapshot endpoint behaviour.
    const exists = await this.oracleRepo.hasTicker(input.ticker);
    if (!exists) {
      throw ApplicationHttpError.notFound(
        `No metadata for ticker ${input.ticker}`,
      );
    }

    // Fetch one more than the cap so we can detect overflow and 400
    // out rather than silently truncating. Limits saturate at the
    // Postgres layer via the repo's `limit` param.
    const points = await this.oracleRepo.findTimeseries({
      ticker: input.ticker,
      measureSlug: input.measure_slug,
      from: input.from,
      to: input.to,
      limit: MAX_POINTS + 1,
    });

    if (points.length > MAX_POINTS) {
      throw ApplicationHttpError.badRequest(
        `Query would return more than ${MAX_POINTS} points; narrow with 'from'/'to'.`,
      );
    }

    return {
      ticker: input.ticker,
      measure_slug: input.measure_slug,
      from: input.from ?? null,
      to: input.to ?? null,
      count: points.length,
      // Unit is returned per-point — the schema stores `unit` per row
      // and a back-correction could legitimately change it between
      // rows. The chart legend renders the unit from the first point
      // by convention.
      points: points.map((p) => ({ date: p.date, value: p.value, unit: p.unit })),
    };
  }
}
