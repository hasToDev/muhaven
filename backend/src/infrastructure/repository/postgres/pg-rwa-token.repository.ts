import { eq, sql } from 'drizzle-orm';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import { RwaToken } from '../../../domain/token-registry/model/rwa-token.js';
import type { TokenStatus, AssetClass } from '../../../domain/token-registry/model/rwa-token.js';
import { rwaTokens } from './schema.js';
import type { Db } from './db.js';

export class PgRwaTokenRepository implements IRwaTokenRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<RwaToken | null> {
    const row = await this.db.query.rwaTokens.findFirst({
      where: eq(rwaTokens.id, id),
    });
    return row ? this.toDomain(row) : null;
  }

  async save(token: RwaToken): Promise<void> {
    await this.db
      .insert(rwaTokens)
      .values({
        id: token.id,
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        issuerAddress: token.issuerAddress,
        apy: token.apy,
        yieldSchedule: token.yieldSchedule,
        kycTier: token.kycTier,
        assetClass: token.assetClass,
        minInvestment: token.minInvestment,
        status: token.status,
        createdAt: token.createdAt,
        updatedAt: token.updatedAt,
        pausedAt: token.pausedAt,
        windingDownAt: token.windingDownAt,
        archivedAt: token.archivedAt,
      })
      .onConflictDoUpdate({
        target: rwaTokens.id,
        set: {
          name: token.name,
          symbol: token.symbol,
          apy: token.apy,
          yieldSchedule: token.yieldSchedule,
          kycTier: token.kycTier,
          assetClass: token.assetClass,
          minInvestment: token.minInvestment,
          status: token.status,
          updatedAt: token.updatedAt,
          pausedAt: token.pausedAt,
          windingDownAt: token.windingDownAt,
          archivedAt: token.archivedAt,
        },
      });
  }

  async findAll(): Promise<RwaToken[]> {
    const rows = await this.db.query.rwaTokens.findMany();
    return rows.map((r) => this.toDomain(r));
  }

  async findByAddress(address: string): Promise<RwaToken | null> {
    const row = await this.db.query.rwaTokens.findFirst({
      where: eq(rwaTokens.address, address),
    });
    return row ? this.toDomain(row) : null;
  }

  async findByIssuer(issuerAddress: string): Promise<RwaToken[]> {
    const rows = await this.db.query.rwaTokens.findMany({
      where: eq(rwaTokens.issuerAddress, issuerAddress),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async findByStatus(status: TokenStatus): Promise<RwaToken[]> {
    const rows = await this.db.query.rwaTokens.findMany({
      where: eq(rwaTokens.status, status),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async update(token: RwaToken): Promise<void> {
    await this.db
      .update(rwaTokens)
      .set({
        name: token.name,
        symbol: token.symbol,
        apy: token.apy,
        yieldSchedule: token.yieldSchedule,
        kycTier: token.kycTier,
        assetClass: token.assetClass,
        minInvestment: token.minInvestment,
        status: token.status,
        updatedAt: token.updatedAt,
        pausedAt: token.pausedAt,
        windingDownAt: token.windingDownAt,
        archivedAt: token.archivedAt,
      })
      .where(eq(rwaTokens.id, token.id));
  }

  /**
   * Phase 9.A · Expansion (F1) — point-update of `issuer_address` driven
   * by the `TokenRegistry.IssuerUpdated` indexer subscription.
   *
   * Address-case posture: viem's event-log decoder hands back checksummed
   * addresses, while the existing `seed-tokens-v35.ts` and
   * `sync-token-issuers.ts` paths also write checksummed (the upstream
   * `getRegisteredTokens` / `getConfig.issuer` reads return
   * EIP-55-checksummed `Address`). Existing rows are therefore
   * checksum-cased in the DB. This method matches the rotation-time
   * indexer feed by lower-casing both sides of the WHERE clause (mirrors
   * the `pg-tax-event.repository.ts:findByHolder` precedent), and writes
   * the new issuer as-supplied so the column shape stays consistent with
   * the seed/sync paths. A new value-cased issuer slots in cleanly next
   * to existing rows; downstream `findByIssuer(addr)` is exact-match, so
   * any caller of that method must already pass the checksummed form
   * (the JWT-derived issuer addr from the `/v1/issuer/*` endpoints
   * already does — see the issuer JWT issue + GetIssuerStatsUseCase).
   */
  async updateIssuer(tokenAddress: string, newIssuer: string): Promise<void> {
    await this.db
      .update(rwaTokens)
      .set({ issuerAddress: newIssuer, updatedAt: new Date() })
      .where(
        eq(sql`lower(${rwaTokens.address})`, tokenAddress.toLowerCase()),
      );
  }

  private toDomain(row: typeof rwaTokens.$inferSelect): RwaToken {
    return new RwaToken({
      id: row.id,
      address: row.address,
      name: row.name,
      symbol: row.symbol,
      issuerAddress: row.issuerAddress,
      apy: row.apy ?? undefined,
      yieldSchedule: row.yieldSchedule ?? undefined,
      kycTier: row.kycTier,
      assetClass: row.assetClass as AssetClass,
      minInvestment: row.minInvestment ?? undefined,
      status: row.status as TokenStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      pausedAt: row.pausedAt ?? undefined,
      windingDownAt: row.windingDownAt ?? undefined,
      archivedAt: row.archivedAt ?? undefined,
    });
  }
}
