import { and, desc, eq, sql } from 'drizzle-orm';
import type { IPortfolioRepository } from '../../../domain/portfolio/repository/portfolio.repository.js';
import { Portfolio } from '../../../domain/portfolio/model/portfolio.js';
import { portfolios } from './schema.js';
import type { Db } from './db.js';

export class PgPortfolioRepository implements IPortfolioRepository {
  constructor(private readonly db: Db) {}

  async save(portfolio: Portfolio): Promise<void> {
    // Lowercase tokenAddress at the boundary. The unique index on
    // (user_id, token_address) is BYTE-EXACT in Postgres, so a row
    // inserted with checksum `0x8D77...` and a re-insert with lowercase
    // `0x8d77...` would BOTH land — neither the onConflict here nor the
    // `findByUserAndToken` existence check below would catch the dup.
    // Surfaced 2026-05-17 when AgentPage's post-buy addPosition hook
    // (lowercase from propose-buy.use-case) duplicated TBILL1 rows that
    // an earlier TradePage buy had written in checksum case. Pattern
    // codified in memory `feedback_address_case_at_repo_boundary`.
    const tokenAddress = portfolio.tokenAddress.toLowerCase();
    await this.db
      .insert(portfolios)
      .values({
        id: portfolio.id,
        userId: portfolio.userId,
        tokenAddress,
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
    // Sort freshest-first by last_synced_at so the frontend's dedup pass
    // (Map<lower-addr, first-seen-wins>) and this repo agree on which
    // row's symbol survives when legacy data carries dups. Pre-2026-05-18
    // we returned rows in insertion order (no ORDER BY), the frontend
    // kept first-seen, the dedup script kept freshest — three different
    // tiebreaks for the same invariant. Aligning here lets the frontend
    // keep its cheap Map-based dedup while still picking the freshest
    // canonical row (Code Reviewer N2).
    //
    // SQL ORDER BY: NULLS LAST puts any never-synced rows last;
    // `id` tiebreak makes the order deterministic across pg planner
    // choices so vitest assertions stay stable.
    const rows = await this.db.query.portfolios.findMany({
      where: eq(portfolios.userId, userId),
      orderBy: [
        sql`${portfolios.lastSyncedAt} DESC NULLS LAST`,
        desc(portfolios.id),
      ],
    });
    return rows.map((r) => this.toDomain(r));
  }

  async findByUserAndToken(userId: string, tokenAddress: string): Promise<Portfolio | null> {
    // Same case-normalization rationale as `save()` — the dedup
    // invariant only holds when every read/write path goes through
    // the lowercased form. Memory `feedback_address_case_at_repo_boundary`.
    const lower = tokenAddress.toLowerCase();
    const row = await this.db.query.portfolios.findFirst({
      where: and(eq(portfolios.userId, userId), eq(portfolios.tokenAddress, lower)),
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
