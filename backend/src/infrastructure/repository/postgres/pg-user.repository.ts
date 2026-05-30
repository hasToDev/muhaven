import { eq, inArray, sql } from 'drizzle-orm';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import { User, type IssuerKybSubmission, type IssuerStatus } from '../../../domain/auth/model/user.js';
import { users } from './schema.js';
import type { Db } from './db.js';

export class PgUserRepository implements IUserRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<User | null> {
    const row = await this.db.query.users.findFirst({
      where: eq(users.id, id),
    });
    return row ? this.toDomain(row) : null;
  }

  async findByWalletAddress(address: string): Promise<User | null> {
    // Lowercase both sides — `wallet_address` column stores whatever
    // case the SIWE / passkey flow handed back (frontend passes the
    // address as-is from `walletStore.connect()`; ZeroDev returns
    // checksummed but other paths may differ). Mirrors the bulk
    // `findByWalletAddresses` posture below + the `lower()` lookups in
    // `pg-rwa-token.repository.ts` and `pg-tax-event.repository.ts`.
    const row = await this.db.query.users.findFirst({
      where: eq(sql`lower(${users.walletAddress})`, address.toLowerCase()),
    });
    return row ? this.toDomain(row) : null;
  }

  async findByWalletAddresses(addresses: string[]): Promise<User[]> {
    if (addresses.length === 0) return [];
    // Lowercase both sides — wallet_address column is stored case-as-supplied
    // and callers may pass EIP-55-checksummed addresses from on-chain reads.
    // Mirrors the `lower()` posture in `pg-rwa-token.repository.ts`.
    const lowered = addresses.map((a) => a.toLowerCase());
    const rows = await this.db.query.users.findMany({
      where: inArray(sql`lower(${users.walletAddress})`, lowered),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async listWalletAddresses(): Promise<string[]> {
    // Wave 5 — kernel-address enumeration for the indexer's UsdcSend topic
    // filter. Column-only select (no toDomain hydration) keeps it cheap even
    // as the user table grows.
    const rows = await this.db
      .select({ walletAddress: users.walletAddress })
      .from(users);
    return rows.map((r) => r.walletAddress);
  }

  async save(user: User): Promise<void> {
    await this.db
      .insert(users)
      .values({
        id: user.id,
        walletAddress: user.walletAddress,
        walletProvider: user.walletProvider,
        role: user.role,
        email: user.email,
        createdAt: user.createdAt,
        issuerStatus: user.issuerStatus,
        issuerDisplayName: user.issuerDisplayName,
        issuerJurisdiction: user.issuerJurisdiction,
        issuerApprovedAt: user.issuerApprovedAt,
        issuerKybSubmission: user.issuerKybSubmission,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          walletAddress: user.walletAddress,
          walletProvider: user.walletProvider,
          role: user.role,
          email: user.email,
          issuerStatus: user.issuerStatus,
          issuerDisplayName: user.issuerDisplayName,
          issuerJurisdiction: user.issuerJurisdiction,
          issuerApprovedAt: user.issuerApprovedAt,
          issuerKybSubmission: user.issuerKybSubmission,
        },
      });
  }

  private toDomain(row: typeof users.$inferSelect): User {
    return new User({
      id: row.id,
      walletAddress: row.walletAddress,
      walletProvider: row.walletProvider,
      role: row.role,
      email: row.email ?? undefined,
      createdAt: row.createdAt,
      issuerStatus: row.issuerStatus as IssuerStatus,
      issuerDisplayName: row.issuerDisplayName ?? undefined,
      issuerJurisdiction: row.issuerJurisdiction ?? undefined,
      issuerApprovedAt: row.issuerApprovedAt ?? undefined,
      issuerKybSubmission:
        (row.issuerKybSubmission as IssuerKybSubmission | null) ?? undefined,
    });
  }
}
