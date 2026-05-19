import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import {
  toTokenListItemDto,
  type TokenListDto,
} from '../../dto/oracle/oracle-read.dto.js';

/**
 * Marketplace list — full catalog of oracle-tracked tokens with the
 * latest snapshot inlined. Bounded by the catalog size (11 today,
 * designed for hundreds). No pagination yet; revisit when the catalog
 * crosses ~500.
 */
export class GetTokenListUseCase {
  constructor(private readonly oracleRepo: IOracleRepository) {}

  async execute(): Promise<TokenListDto> {
    const items = await this.oracleRepo.findMetadataList();
    return { tokens: items.map(toTokenListItemDto) };
  }
}
