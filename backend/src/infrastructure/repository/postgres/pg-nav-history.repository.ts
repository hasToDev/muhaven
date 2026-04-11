import { and, eq, desc, gte, lte, sql } from 'drizzle-orm';
import type {
  INavHistoryRepository,
  FindNavHistoryOptions,
} from '../../../domain/nav-history/repository/nav-history.repository.js';
import { NavSnapshot } from '../../../domain/nav-history/model/nav-snapshot.js';
import type { NavSourceType } from '../../../domain/nav-history/model/nav-snapshot.js';
import { tokenNavHistory } from './schema.js';
import type { Db } from './db.js';

export class PgNavHistoryRepository implements INavHistoryRepository {
  constructor(private readonly db: Db) {}

  async save(snapshot: NavSnapshot): Promise<void> {
    await this.db.insert(tokenNavHistory).values({
      id: snapshot.id,
      tokenAddress: snapshot.tokenAddress,
      nav: snapshot.nav,
      apy: snapshot.apy,
      totalAum: snapshot.totalAum,
      yieldRate: snapshot.yieldRate,
      source: snapshot.source,
      sourceType: snapshot.sourceType,
      sourceTimestamp: snapshot.sourceTimestamp,
      fetchedAt: snapshot.fetchedAt,
      createdAt: snapshot.createdAt,
    });
  }

  async findByToken(tokenAddress: string, options?: FindNavHistoryOptions): Promise<NavSnapshot[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const conditions = [eq(tokenNavHistory.tokenAddress, tokenAddress)];

    if (options?.from) {
      conditions.push(gte(tokenNavHistory.fetchedAt, options.from));
    }
    if (options?.to) {
      conditions.push(lte(tokenNavHistory.fetchedAt, options.to));
    }

    const rows = await this.db.query.tokenNavHistory.findMany({
      where: and(...conditions),
      orderBy: [desc(tokenNavHistory.fetchedAt)],
      limit,
      offset,
    });

    return rows.map((r) => this.toDomain(r));
  }

  async findLatestByToken(tokenAddress: string): Promise<NavSnapshot | null> {
    const row = await this.db.query.tokenNavHistory.findFirst({
      where: eq(tokenNavHistory.tokenAddress, tokenAddress),
      orderBy: [desc(tokenNavHistory.fetchedAt)],
    });
    return row ? this.toDomain(row) : null;
  }

  async findLatestForAllTokens(): Promise<NavSnapshot[]> {
    // DISTINCT ON (token_address) picks one row per token, ordered by fetchedAt desc
    const rows = await this.db.execute<typeof tokenNavHistory.$inferSelect>(
      sql`SELECT DISTINCT ON (${tokenNavHistory.tokenAddress}) *
          FROM ${tokenNavHistory}
          ORDER BY ${tokenNavHistory.tokenAddress}, ${tokenNavHistory.fetchedAt} DESC`,
    );

    return rows.rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: typeof tokenNavHistory.$inferSelect): NavSnapshot {
    return new NavSnapshot({
      id: row.id,
      tokenAddress: row.tokenAddress,
      nav: row.nav,
      apy: row.apy ?? undefined,
      totalAum: row.totalAum ?? undefined,
      yieldRate: row.yieldRate ?? undefined,
      source: row.source,
      sourceType: row.sourceType as NavSourceType,
      sourceTimestamp: row.sourceTimestamp ?? undefined,
      fetchedAt: row.fetchedAt,
      createdAt: row.createdAt,
    });
  }
}
