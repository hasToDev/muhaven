import type { Portfolio } from '../model/portfolio.js';

export interface IPortfolioRepository {
  save(portfolio: Portfolio): Promise<void>;
  findByUserId(userId: string): Promise<Portfolio[]>;
  findByUserAndToken(userId: string, tokenAddress: string): Promise<Portfolio | null>;
  delete(id: string): Promise<void>;
}
