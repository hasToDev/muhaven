import type { RwaToken, TokenStatus } from '../model/rwa-token.js';

export interface IRwaTokenRepository {
  save(token: RwaToken): Promise<void>;
  findById(id: string): Promise<RwaToken | null>;
  findAll(): Promise<RwaToken[]>;
  findByAddress(address: string): Promise<RwaToken | null>;
  findByIssuer(issuerAddress: string): Promise<RwaToken[]>;
  findByStatus(status: TokenStatus): Promise<RwaToken[]>;
  update(token: RwaToken): Promise<void>;
}
