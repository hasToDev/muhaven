import type { TaxEvent } from '../model/tax-event.js';

export interface ITaxEventRepository {
  /**
   * Insert markers idempotently. The `(tx_hash, log_index)` PRIMARY KEY makes
   * duplicate events from a re-poll a no-op. Returns the count of newly-
   * persisted markers.
   */
  saveMany(events: TaxEvent[]): Promise<number>;
  findByHolder(holderAddress: string, limit: number): Promise<TaxEvent[]>;
}
