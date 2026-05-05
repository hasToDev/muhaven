import { and, asc, eq, gt, gte, inArray, lte, or } from 'drizzle-orm';
import type {
  AuditEventQueryOptions,
  IAgentAuditRepository,
  PaginatedAuditEvents,
} from '../../../domain/agent/repository/agent-audit.repository.js';
import { AgentAuditEvent } from '../../../domain/agent/model/agent-audit-event.js';
import type { AuditEventType } from '../../../domain/agent/model/audit-event-type.enum.js';
import type { Surface } from '../../../domain/agent/model/surface.enum.js';
import type { Tier } from '../../../domain/agent/model/tier.enum.js';
import type { Trigger } from '../../../domain/agent/model/trigger.enum.js';
import { ActionId, isActionId } from '../../../domain/agent/model/action-id.enum.js';
import { agentAuditEvents } from './schema.js';
import type { Db } from './db.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

interface CursorPayload {
  createdAt: string; // ISO
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorPayload | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append-only Postgres backing for the agent audit log.
 *
 * The interface deliberately omits `update` and `delete` to enforce the
 * WORM property at the type level. The Postgres role used by the backend
 * should additionally have UPDATE/DELETE revoked on this table for
 * defense in depth.
 */
export class PgAgentAuditRepository implements IAgentAuditRepository {
  constructor(private readonly db: Db) {}

  async append(event: AgentAuditEvent): Promise<void> {
    await this.db.insert(agentAuditEvents).values({
      id: event.id,
      userId: event.userId,
      surface: event.surface,
      eventType: event.eventType,
      tierBefore: event.tierBefore,
      tierAfter: event.tierAfter,
      trigger: event.trigger,
      actionId: event.actionId,
      metadata: event.metadata,
      createdAt: event.createdAt,
    });
  }

  async findByUserId(userId: string, options?: AuditEventQueryOptions): Promise<PaginatedAuditEvents> {
    const limit = Math.min(options?.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const cursor = decodeCursor(options?.cursor);

    const conditions = [eq(agentAuditEvents.userId, userId)];
    if (options?.since) conditions.push(gte(agentAuditEvents.createdAt, options.since));
    if (options?.until) conditions.push(lte(agentAuditEvents.createdAt, options.until));
    if (options?.surface) conditions.push(eq(agentAuditEvents.surface, options.surface));
    if (options?.eventTypes && options.eventTypes.length > 0) {
      conditions.push(inArray(agentAuditEvents.eventType, options.eventTypes));
    }
    if (cursor) {
      // Tuple comparison: rows after the cursor in (createdAt, id) order.
      // Using `gt(createdAt)` alone would silently drop rows that share
      // a sub-ms `defaultNow()` timestamp with the cursor row (realistic
      // on burst writes — e.g. the 4-surface pause cascade fan-out).
      const cursorCreatedAt = new Date(cursor.createdAt);
      const tieBreaker = and(
        eq(agentAuditEvents.createdAt, cursorCreatedAt),
        gt(agentAuditEvents.id, cursor.id),
      );
      conditions.push(
        or(gt(agentAuditEvents.createdAt, cursorCreatedAt), tieBreaker)!,
      );
    }

    const rows = await this.db
      .select()
      .from(agentAuditEvents)
      .where(and(...conditions))
      .orderBy(asc(agentAuditEvents.createdAt), asc(agentAuditEvents.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) => this.toDomain(row));
    const nextCursor = hasMore
      ? encodeCursor({ createdAt: page[page.length - 1].createdAt.toISOString(), id: page[page.length - 1].id })
      : undefined;

    return { items, cursor: nextCursor };
  }

  private toDomain(row: typeof agentAuditEvents.$inferSelect): AgentAuditEvent {
    const actionIdRaw = row.actionId;
    const actionId = isActionId(actionIdRaw) ? (actionIdRaw as ActionId) : null;

    return new AgentAuditEvent({
      id: row.id,
      userId: row.userId,
      surface: row.surface as Surface,
      eventType: row.eventType as AuditEventType,
      tierBefore: (row.tierBefore as Tier | null) ?? null,
      tierAfter: (row.tierAfter as Tier | null) ?? null,
      trigger: (row.trigger as Trigger | null) ?? null,
      actionId,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt,
    });
  }
}
