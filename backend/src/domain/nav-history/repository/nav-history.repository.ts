import type { NavSnapshot } from '../model/nav-snapshot.js';

export interface FindNavHistoryOptions {
  limit?: number;
  offset?: number;
  from?: Date;
  to?: Date;
}

export interface INavHistoryRepository {
  save(snapshot: NavSnapshot): Promise<void>;
  findByToken(tokenAddress: string, options?: FindNavHistoryOptions): Promise<NavSnapshot[]>;
  findLatestByToken(tokenAddress: string): Promise<NavSnapshot | null>;
  findLatestForAllTokens(): Promise<NavSnapshot[]>;
}
