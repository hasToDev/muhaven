import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import {
  toOracleTimeseriesDto,
  type OracleTimeseriesDto,
} from '../../dto/oracle/oracle-read.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';

/**
 * Hard ceiling on a single response. USYC has the largest current
 * series (~5,700 points); 10,000 leaves headroom for the longest
 * realistic measure × ticker without inviting unbounded payloads from
 * cache-busted query fan-out. Clients who legitimately need more must
 * narrow with `from` / `to`.
 */
const MAX_POINTS = 10_000;

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
    // "unknown token" from "known token, no points in range." Single-
    // row PK lookup is the same cost as a dedicated existence probe,
    // so we re-use `findMetadata` instead of carrying a one-call-site
    // interface method.
    const meta = await this.oracleRepo.findMetadata(input.ticker);
    if (!meta) {
      throw ApplicationHttpError.notFound(
        `No metadata for ticker ${input.ticker}`,
      );
    }

    // Fetch one above the cap so we can detect overflow and 400 out
    // rather than silently truncating.
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

    // Use the canonical case-preserved ticker from the metadata row,
    // not the consumer's input — keeps the DTO consistent regardless
    // of how the consumer spelled the case-insensitive lookup.
    return toOracleTimeseriesDto(
      meta.ticker,
      input.measure_slug,
      input.from ?? null,
      input.to ?? null,
      points,
    );
  }
}
