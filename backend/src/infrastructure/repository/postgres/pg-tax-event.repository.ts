import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  AcquisitionsByToken,
  DailyCount,
  DispositionsByKindResult,
  ITaxEventRepository,
  TaxEventCountsByType,
} from '../../../domain/tax-event/repository/tax-event.repository.js';
import {
  INVESTOR_ACTIVITY_EVENT_TYPES,
  TaxEvent,
} from '../../../domain/tax-event/model/tax-event.js';
import type { TaxEventType } from '../../../domain/tax-event/model/tax-event.js';
import { taxEvents } from './schema.js';
import type { Db } from './db.js';

const ALL_EVENT_TYPES: TaxEventType[] = [
  'Acquisition',
  'Disposition',
  'IncomeAccrual',
  'FeeEvent',
  'Wrap',
  'Unwrap',
  'Transfer',
];

function emptyCounts(): TaxEventCountsByType {
  return {
    Acquisition: 0,
    Disposition: 0,
    IncomeAccrual: 0,
    FeeEvent: 0,
    Wrap: 0,
    Unwrap: 0,
    Transfer: 0,
  };
}

function dayKey(d: Date): string {
  // ISO date YYYY-MM-DD in UTC. Postgres `date_trunc('day', ts)` returns a
  // timestamp at 00:00 UTC; toISOString → "YYYY-MM-DDT00:00:00.000Z" → slice
  // gives us the canonical day key.
  return d.toISOString().slice(0, 10);
}

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

  async hasInvestorActivity(holderAddress: string): Promise<boolean> {
    const row = await this.db
      .select({ one: sql<number>`1` })
      .from(taxEvents)
      .where(
        and(
          eq(sql`lower(${taxEvents.holderAddress})`, holderAddress.toLowerCase()),
          inArray(taxEvents.eventType, INVESTOR_ACTIVITY_EVENT_TYPES),
        ),
      )
      .limit(1);
    return row.length > 0;
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

  async aggregateCounts(): Promise<TaxEventCountsByType> {
    const rows = await this.db
      .select({
        eventType: taxEvents.eventType,
        count: sql<string>`count(*)`,
      })
      .from(taxEvents)
      .groupBy(taxEvents.eventType);

    const out = emptyCounts();
    for (const r of rows) {
      // event_type is a pg enum so the value matches one of the seven
      // TaxEventType strings; defensively guard so an unexpected enum
      // expansion never throws here (the map starts at 0 for all keys).
      if (ALL_EVENT_TYPES.includes(r.eventType as TaxEventType)) {
        out[r.eventType as TaxEventType] = Number(r.count);
      }
    }
    return out;
  }

  async dailyCounts(eventType: TaxEventType): Promise<DailyCount[]> {
    const rows = await this.db
      .select({
        day: sql<Date>`date_trunc('day', ${taxEvents.blockTimestamp})`,
        count: sql<string>`count(*)`,
      })
      .from(taxEvents)
      .where(eq(taxEvents.eventType, eventType))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    return rows.map((r) => ({
      day: dayKey(r.day instanceof Date ? r.day : new Date(r.day as unknown as string)),
      count: Number(r.count),
    }));
  }

  async acquisitionsByToken(): Promise<AcquisitionsByToken[]> {
    const rows = await this.db
      .select({
        tokenAddress: sql<string>`lower(${taxEvents.tokenAddress})`,
        count: sql<string>`count(*)`,
      })
      .from(taxEvents)
      .where(
        sql`${taxEvents.eventType} = 'Acquisition' AND ${taxEvents.tokenAddress} IS NOT NULL`,
      )
      .groupBy(sql`1`);

    return rows
      .filter((r) => r.tokenAddress !== null)
      .map((r) => ({
        tokenAddress: r.tokenAddress,
        count: Number(r.count),
      }));
  }

  async dispositionsByKind(): Promise<DispositionsByKindResult> {
    const totalRows = await this.db
      .select({
        kind: sql<string | null>`${taxEvents.metadata}->>'kind'`,
        count: sql<string>`count(*)`,
      })
      .from(taxEvents)
      .where(eq(taxEvents.eventType, 'Disposition'))
      .groupBy(sql`1`);

    const totals = { instant: 0, queued: 0, escalatedToQueue: 0 };
    for (const r of totalRows) {
      const n = Number(r.count);
      if (r.kind === 'instant') totals.instant += n;
      else if (r.kind === 'queued') totals.queued += n;
      else if (r.kind === 'escalated_to_queue') totals.escalatedToQueue += n;
      // Unknown kinds (or null metadata) are intentionally dropped from
      // the totals — the public taxonomy is documented and adding a new
      // kind is a deliberate schema change, not a metric drift.
    }

    const dayRows = await this.db
      .select({
        day: sql<Date>`date_trunc('day', ${taxEvents.blockTimestamp})`,
        kind: sql<string | null>`${taxEvents.metadata}->>'kind'`,
        count: sql<string>`count(*)`,
      })
      .from(taxEvents)
      .where(eq(taxEvents.eventType, 'Disposition'))
      .groupBy(sql`1, 2`)
      .orderBy(sql`1`);

    const byDayMap = new Map<
      string,
      { instant: number; queued: number; escalatedToQueue: number }
    >();
    for (const r of dayRows) {
      const day = dayKey(
        r.day instanceof Date ? r.day : new Date(r.day as unknown as string),
      );
      const slot = byDayMap.get(day) ?? { instant: 0, queued: 0, escalatedToQueue: 0 };
      const n = Number(r.count);
      if (r.kind === 'instant') slot.instant += n;
      else if (r.kind === 'queued') slot.queued += n;
      else if (r.kind === 'escalated_to_queue') slot.escalatedToQueue += n;
      byDayMap.set(day, slot);
    }
    const byDay = Array.from(byDayMap.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([day, kinds]) => ({ day, ...kinds }));

    return { totals, byDay };
  }
}
