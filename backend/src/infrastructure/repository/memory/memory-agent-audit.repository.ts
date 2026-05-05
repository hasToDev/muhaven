import type {
  AuditEventQueryOptions,
  IAgentAuditRepository,
  PaginatedAuditEvents,
} from '../../../domain/agent/repository/agent-audit.repository.js';
import type { AgentAuditEvent } from '../../../domain/agent/model/agent-audit-event.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

interface CursorPayload {
  createdAt: string;
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
 * In-memory append-only audit store. Mirrors the Postgres implementation's
 * WORM contract — no update or delete method is exposed (or implemented).
 */
export class MemoryAgentAuditRepository implements IAgentAuditRepository {
  private readonly store: AgentAuditEvent[] = [];

  async append(event: AgentAuditEvent): Promise<void> {
    this.store.push(event);
  }

  async findByUserId(userId: string, options?: AuditEventQueryOptions): Promise<PaginatedAuditEvents> {
    const limit = Math.min(options?.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const cursor = decodeCursor(options?.cursor);

    const filtered = this.store
      .filter((e) => e.userId === userId)
      .filter((e) => (options?.since ? e.createdAt >= options.since : true))
      .filter((e) => (options?.until ? e.createdAt <= options.until : true))
      .filter((e) => (options?.surface ? e.surface === options.surface : true))
      .filter((e) => {
        if (!options?.eventTypes || options.eventTypes.length === 0) return true;
        return options.eventTypes.includes(e.eventType);
      })
      .filter((e) => {
        if (!cursor) return true;
        // Tuple comparison on (createdAt, id) — must match the postgres
        // implementation. Greater-than-only on createdAt would silently
        // drop rows that share a sub-ms timestamp with the cursor row
        // (realistic on burst writes — e.g. 4-surface pause cascade).
        const cursorTs = new Date(cursor.createdAt).getTime();
        const eTs = e.createdAt.getTime();
        if (eTs > cursorTs) return true;
        if (eTs === cursorTs) return e.id > cursor.id;
        return false;
      })
      .sort((a, b) => {
        const dt = a.createdAt.getTime() - b.createdAt.getTime();
        return dt !== 0 ? dt : a.id.localeCompare(b.id);
      });

    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    const nextCursor = hasMore
      ? encodeCursor({
          createdAt: page[page.length - 1].createdAt.toISOString(),
          id: page[page.length - 1].id,
        })
      : undefined;

    return { items: page, cursor: nextCursor };
  }
}
