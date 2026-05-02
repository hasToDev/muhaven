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
  save(user: User): Promise<void>;
}
