import type { User } from '../model/user.js';

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByWalletAddress(address: string): Promise<User | null>;
  /**
   * Bulk lookup by wallet address with case-insensitive match. Used by the
   * tokens endpoints to attach `issuer_display_name` to the public token
   * catalogue (Phase 9.A · Expansion · F3 multi-issuer marketplace
   * metadata). Returns the rows it finds; addresses without a matching
   * user row are silently dropped (the consumer falls back to a formatted
   * address).
   */
  findByWalletAddresses(addresses: string[]): Promise<User[]>;
  /**
   * Wave 5 — list every user's kernel wallet address. Used by the tax-event
   * indexer's `UsdcSend` leg to build the `from: [kernels]` topic filter so
   * the GLOBAL USDC contract's Transfer logs are scoped to our users (never
   * global volume). Returns the raw stored addresses (case-as-supplied); the
   * indexer normalises case as needed.
   *
   * Optional: only the production Postgres repo implements it (the tax-event
   * indexer that consumes it runs only against postgres). The in-memory
   * test/dev repo may omit it — callers MUST optional-chain + fall back to an
   * empty set, which disables the UsdcSend leg in those environments.
   */
  listWalletAddresses?(): Promise<string[]>;
  save(user: User): Promise<void>;
}
