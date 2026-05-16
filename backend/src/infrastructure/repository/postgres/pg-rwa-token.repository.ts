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
        yieldSnapshotAddress: token.yieldSnapshotAddress,
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
          // `yieldSnapshotAddress` is INTENTIONALLY omitted from the SET
          // clause for the same reason as `issuerAddress`: this path is
          // also the re-seed bootstrap (`seed:tokens:v35` → `save()`),
          // and keeping the column out of the conflict-update guarantees
          // a re-seed cannot clobber a per-token snapshot address the F2
          // wizard wrote at deploy time. Inserts (first call) DO write
          // it via the `values` clause above.
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
    // Lowercase both sides — `address` column stores whatever case the
    // inserter supplied (seed-tokens-v35 writes viem-checksummed,
    // F2 wizard writes JWT-derived which may be either case). Mirrors
    // the `lower()` posture in `updateIssuer` + `pg-tax-event.findByHolder`.
    const row = await this.db.query.rwaTokens.findFirst({
      where: eq(sql`lower(${rwaTokens.address})`, address.toLowerCase()),
    });
    return row ? this.toDomain(row) : null;
  }

  async findByIssuer(issuerAddress: string): Promise<RwaToken[]> {
    // Lowercase both sides — see `findByAddress` rationale. The JWT's
    // walletAddress (which `/v1/issuer/tokens` derives the issuer
    // address from) is stored in `users.wallet_address` as-supplied
    // by the frontend, while `rwa_tokens.issuer_address` is written
    // checksummed by the F1 indexer / seed-tokens-v35 path. A case
    // divergence between the two caused the issuer dashboard to
    // render empty even when the row existed.
    const rows = await this.db.query.rwaTokens.findMany({
      where: eq(sql`lower(${rwaTokens.issuerAddress})`, issuerAddress.toLowerCase()),
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
   * EIP-55-checksummed `Address`). The F2 wizard writes whatever case
   * the JWT-derived `users.wallet_address` carries — which can diverge
   * from the on-chain checksum form depending on the SIWE / passkey
   * flow. This method (and every other `where` predicate on
   * `issuer_address` / `address` in this repo) lower-cases both sides
   * to immunize against that mismatch. Mirrors `findByHolder` in
   * `pg-tax-event.repository.ts`.
   */
  async updateIssuer(tokenAddress: string, newIssuer: string): Promise<void> {
    await this.db
      .update(rwaTokens)
      .set({ issuerAddress: newIssuer, updatedAt: new Date() })
      .where(
        eq(sql`lower(${rwaTokens.address})`, tokenAddress.toLowerCase()),
      );
  }

  async updatePausedStatus(tokenAddress: string, paused: boolean): Promise<void> {
    const now = new Date();
    await this.db
      .update(rwaTokens)
      .set(
        paused
          ? { status: 'paused', pausedAt: now, updatedAt: now }
          : { status: 'active', pausedAt: null, updatedAt: now },
      )
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
      yieldSnapshotAddress: row.yieldSnapshotAddress ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      pausedAt: row.pausedAt ?? undefined,
      windingDownAt: row.windingDownAt ?? undefined,
      archivedAt: row.archivedAt ?? undefined,
    });
  }
}
