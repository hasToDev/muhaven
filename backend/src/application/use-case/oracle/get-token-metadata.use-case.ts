import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import {
  toTokenMetadataDto,
  type TokenMetadataDto,
} from '../../dto/oracle/oracle-read.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';

export class GetTokenMetadataUseCase {
  constructor(private readonly oracleRepo: IOracleRepository) {}

  async execute(ticker: string): Promise<TokenMetadataDto> {
    const meta = await this.oracleRepo.findMetadata(ticker);
    if (!meta) {
      throw ApplicationHttpError.notFound(`No metadata for ticker ${ticker}`);
    }
    return toTokenMetadataDto(meta);
  }
}
