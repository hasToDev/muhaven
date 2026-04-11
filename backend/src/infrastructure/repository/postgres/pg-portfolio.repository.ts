import { and, eq } from 'drizzle-orm';
import type { IPortfolioRepository } from '../../../domain/portfolio/repository/portfolio.repository.js';
import { Portfolio } from '../../../domain/portfolio/model/portfolio.js';
import { portfolios } from './schema.js';
import type { Db } from './db.js';

export class PgPortfolioRepository implements IPortfolioRepository {
  constructor(private readonly db: Db) {}

  async save(portfolio: Portfolio): Promise<void> {
    await this.db
      .insert(portfolios)
      .values({
        id: portfolio.id,
        userId: portfolio.userId,
        tokenAddress: portfolio.tokenAddress,
        tokenSymbol: portfolio.tokenSymbol,
        lastSyncedAt: portfolio.lastSyncedAt,
      })
      .onConflictDoUpdate({
        target: [portfolios.userId, portfolios.tokenAddress],
        set: {
          tokenSymbol: portfolio.tokenSymbol,
          lastSyncedAt: portfolio.lastSyncedAt,
        },
      });
  }

  async findByUserId(userId: string): Promise<Portfolio[]> {
    const rows = await this.db.query.portfolios.findMany({
      where: eq(portfolios.userId, userId),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async findByUserAndToken(userId: string, tokenAddress: string): Promise<Portfolio | null> {
    const row = await this.db.query.portfolios.findFirst({
      where: and(eq(portfolios.userId, userId), eq(portfolios.tokenAddress, tokenAddress)),
    });
    return row ? this.toDomain(row) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(portfolios).where(eq(portfolios.id, id));
  }

  private toDomain(row: typeof portfolios.$inferSelect): Portfolio {
    return new Portfolio({
      id: row.id,
      userId: row.userId,
      tokenAddress: row.tokenAddress,
      tokenSymbol: row.tokenSymbol,
      lastSyncedAt: row.lastSyncedAt ?? undefined,
    });
  }
}
