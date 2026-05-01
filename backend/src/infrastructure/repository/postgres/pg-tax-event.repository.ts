import { desc, eq, sql } from 'drizzle-orm';
import type { ITaxEventRepository } from '../../../domain/tax-event/repository/tax-event.repository.js';
import { TaxEvent } from '../../../domain/tax-event/model/tax-event.js';
import type { TaxEventType } from '../../../domain/tax-event/model/tax-event.js';
import { taxEvents } from './schema.js';
import type { Db } from './db.js';

export class PgTaxEventRepository implements ITaxEventRepository {
  constructor(private readonly db: Db) {}

  async saveMany(events: TaxEvent[]): Promise<number> {
    if (events.length === 0) return 0;

    const values = events.map((e) => ({
      txHash: e.txHash,
      logIndex: e.logIndex,
      eventType: e.eventType,
      holderAddress: e.holderAddress,
      tokenAddress: e.tokenAddress,
      blockNumber: e.blockNumber,
      blockTimestamp: e.blockTimestamp,
      navAtTime: e.navAtTime,
      referenceId: e.referenceId,
      metadata: e.metadata,
      createdAt: e.createdAt,
    }));

    // Idempotent insert keyed on the table's PRIMARY KEY. Phase 9.A · Option Z
    // follow-up widened the PK from (tx_hash, log_index) to
    // (tx_hash, log_index, holder_address) so a single Transfer event can
    // produce two rows (sender + recipient). The ON CONFLICT target MUST
    // mirror the actual unique constraint exactly — passing only
    // (tx_hash, log_index) errors with "no unique or exclusion constraint
    // matching the ON CONFLICT specification" (Postgres 42P10), the
    // indexer tick fails, and the cursor doesn't advance.
    const inserted = await this.db
      .insert(taxEvents)
      .values(values)
      .onConflictDoNothing({
        target: [taxEvents.txHash, taxEvents.logIndex, taxEvents.holderAddress],
      })
      .returning({ txHash: taxEvents.txHash });
    return inserted.length;
  }

  async findByHolder(holderAddress: string, limit: number): Promise<TaxEvent[]> {
    const rows = await this.db
      .select()
      .from(taxEvents)
      .where(eq(sql`lower(${taxEvents.holderAddress})`, holderAddress.toLowerCase()))
      .orderBy(desc(taxEvents.blockTimestamp))
      .limit(limit);

    return rows.map(
      (r) =>
        new TaxEvent({
          txHash: r.txHash,
          logIndex: r.logIndex,
          eventType: r.eventType as TaxEventType,
          holderAddress: r.holderAddress,
          tokenAddress: r.tokenAddress,
          blockNumber: r.blockNumber,
          blockTimestamp: r.blockTimestamp,
          navAtTime: r.navAtTime,
          referenceId: r.referenceId,
          metadata: (r.metadata as Record<string, unknown> | null) ?? null,
          createdAt: r.createdAt,
        }),
    );
  }
}
