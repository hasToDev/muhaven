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
    // Wrap both sides with lower() — `nav-worker` writes checksummed
    // addresses (mixed case from `engine.ts:STAGING_TBILL1` etc.) but
    // every caller of this repo lowercases at the boundary. A plain
    // `eq(col, input)` would silently miss. Memory rule
    // `feedback_address_case_at_repo_boundary` (2026-05-09).
    const lowered = tokenAddress.toLowerCase();
    const conditions = [eq(sql`lower(${tokenNavHistory.tokenAddress})`, lowered)];

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
    // See findByToken comment — case-insensitive at the repo boundary.
    const lowered = tokenAddress.toLowerCase();
    const row = await this.db.query.tokenNavHistory.findFirst({
      where: eq(sql`lower(${tokenNavHistory.tokenAddress})`, lowered),
      orderBy: [desc(tokenNavHistory.fetchedAt)],
    });
    return row ? this.toDomain(row) : null;
  }

  async findLatestForAllTokens(): Promise<NavSnapshot[]> {
    // DISTINCT ON LOWER(token_address) so writers using different case
    // conventions (checksummed from nav-worker, lowercase from indexer
    // backfill) collapse into a single canonical group per token.
    //
    // NB: `db.execute<>(sql`SELECT *...`)` returns rows with raw Postgres
    // column names (snake_case), NOT Drizzle's camelCase schema aliases.
    // Use the `RawNavHistoryRow` shape + `toDomainFromRaw` to map snake_case
    // → domain explicitly. Surfaced in CI 2026-05-11 when the integration
    // test hit `TypeError: Cannot read properties of undefined (reading
    // 'toLowerCase')` on `row.tokenAddress`.
    const rows = await this.db.execute<RawNavHistoryRow>(
      sql`SELECT DISTINCT ON (lower(${tokenNavHistory.tokenAddress})) *
          FROM ${tokenNavHistory}
          ORDER BY lower(${tokenNavHistory.tokenAddress}), ${tokenNavHistory.fetchedAt} DESC`,
    );

    return rows.rows.map((r) => this.toDomainFromRaw(r));
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

  private toDomainFromRaw(row: RawNavHistoryRow): NavSnapshot {
    return new NavSnapshot({
      id: row.id,
      tokenAddress: row.token_address,
      nav: row.nav,
      apy: row.apy ?? undefined,
      totalAum: row.total_aum ?? undefined,
      yieldRate: row.yield_rate ?? undefined,
      source: row.source,
      sourceType: row.source_type as NavSourceType,
      sourceTimestamp: row.source_timestamp ?? undefined,
      fetchedAt: row.fetched_at,
      createdAt: row.created_at,
    });
  }
}

/**
 * Raw row shape for `db.execute(sql...)` queries against `token_nav_history`.
 * Drizzle's `$inferSelect` returns camelCase column aliases for `db.query.*`
 * paths, but raw `db.execute<>` paths yield the underlying snake_case column
 * names — this type captures that wire shape so the per-path mapper stays
 * type-checked.
 */
interface RawNavHistoryRow extends Record<string, unknown> {
  id: string;
  token_address: string;
  nav: string;
  apy: string | null;
  total_aum: string | null;
  yield_rate: string | null;
  source: string;
  source_type: string;
  source_timestamp: Date | null;
  fetched_at: Date;
  created_at: Date;
}
