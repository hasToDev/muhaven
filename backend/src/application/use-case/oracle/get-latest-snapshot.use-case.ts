import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import {
  toOracleSnapshotDto,
  type OracleSnapshotDto,
} from '../../dto/oracle/oracle-read.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';

export class GetLatestSnapshotUseCase {
  constructor(private readonly oracleRepo: IOracleRepository) {}

  async execute(ticker: string): Promise<OracleSnapshotDto> {
    const snap = await this.oracleRepo.findLatestSnapshot(ticker);
    if (!snap) {
      throw ApplicationHttpError.notFound(
        `No oracle snapshot for ticker ${ticker}`,
      );
    }
    return toOracleSnapshotDto(snap);
  }
}
