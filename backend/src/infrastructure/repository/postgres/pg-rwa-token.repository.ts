import { eq } from 'drizzle-orm';
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
