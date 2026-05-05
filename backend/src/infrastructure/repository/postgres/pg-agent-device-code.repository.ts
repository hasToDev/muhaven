import { and, eq, gt, lt, or } from 'drizzle-orm';
import type {
  AuthorizeDeviceCodeInput,
  DenyDeviceCodeInput,
  IAgentDeviceCodeRepository,
  IssueDeviceCodeInput,
} from '../../../domain/auth/repository/agent-device-code.repository.js';
import {
  AgentDeviceCode,
  type DeviceCodeStatus,
  type RequesterMetadata,
} from '../../../domain/auth/model/agent-device-code.js';
import { agentDeviceCodes } from './schema.js';
import type { Db } from './db.js';

export class PgAgentDeviceCodeRepository implements IAgentDeviceCodeRepository {
  constructor(private readonly db: Db) {}

  async issue(input: IssueDeviceCodeInput): Promise<AgentDeviceCode> {
    const inserted = await this.db
      .insert(agentDeviceCodes)
      .values({
        deviceCode: input.deviceCode,
        userCode: input.userCode,
        status: 'pending',
        requesterMetadata: input.requesterMetadata,
        expiresAt: input.expiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    return this.toDomain(inserted[0]);
  }

  async findByDeviceCode(deviceCode: string): Promise<AgentDeviceCode | null> {
    const row = await this.db.query.agentDeviceCodes.findFirst({
      where: eq(agentDeviceCodes.deviceCode, deviceCode),
    });
    return row ? this.toDomain(row) : null;
  }

  async findByUserCode(userCode: string): Promise<AgentDeviceCode | null> {
    const row = await this.db.query.agentDeviceCodes.findFirst({
      where: eq(agentDeviceCodes.userCode, userCode),
    });
    return row ? this.toDomain(row) : null;
  }

  async authorize(input: AuthorizeDeviceCodeInput): Promise<AgentDeviceCode | null> {
    const updated = await this.db
      .update(agentDeviceCodes)
      .set({
        status: 'authorized',
        userId: input.userId,
        jwt: input.jwt,
        scope: input.scope,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(agentDeviceCodes.userCode, input.userCode),
          eq(agentDeviceCodes.status, 'pending'),
          gt(agentDeviceCodes.expiresAt, input.now),
        ),
      )
      .returning();
    return updated.length > 0 ? this.toDomain(updated[0]) : null;
  }

  async deny(input: DenyDeviceCodeInput): Promise<AgentDeviceCode | null> {
    const updated = await this.db
      .update(agentDeviceCodes)
      .set({
        status: 'denied',
        userId: input.userId,
        denyReason: input.reason ?? null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(agentDeviceCodes.userCode, input.userCode),
          eq(agentDeviceCodes.status, 'pending'),
        ),
      )
      .returning();
    return updated.length > 0 ? this.toDomain(updated[0]) : null;
  }

  async consume(deviceCode: string, now: Date): Promise<{ jwt: string; scope: string[] } | null> {
    // Postgres UPDATE … RETURNING returns the POST-update column values,
    // so we must capture the JWT BEFORE clearing it. Two-step: read the
    // current jwt under a conditional check, then atomically flip the
    // status (still gated on `authorized`) so a racer who saw the same
    // jwt also has to win the conditional UPDATE.
    const row = await this.db.query.agentDeviceCodes.findFirst({
      where: and(
        eq(agentDeviceCodes.deviceCode, deviceCode),
        eq(agentDeviceCodes.status, 'authorized'),
      ),
    });
    if (!row || !row.jwt) return null;
    const jwt = row.jwt;
    const scope = (row.scope as string[] | null) ?? [];

    const updated = await this.db
      .update(agentDeviceCodes)
      .set({ status: 'consumed', jwt: null, updatedAt: now })
      .where(
        and(
          eq(agentDeviceCodes.deviceCode, deviceCode),
          eq(agentDeviceCodes.status, 'authorized'),
        ),
      )
      .returning({ deviceCode: agentDeviceCodes.deviceCode });
    if (updated.length === 0) return null; // lost the race — fail closed
    return { jwt, scope };
  }

  async sweepExpired(now: Date): Promise<number> {
    // Flip pending OR authorized rows past their expiry to `expired`.
    // `consumed` / `denied` / `expired` are terminal — leave them.
    const updated = await this.db
      .update(agentDeviceCodes)
      .set({ status: 'expired', jwt: null, updatedAt: now })
      .where(
        and(
          or(
            eq(agentDeviceCodes.status, 'pending'),
            eq(agentDeviceCodes.status, 'authorized'),
          ),
          lt(agentDeviceCodes.expiresAt, now),
        ),
      )
      .returning({ deviceCode: agentDeviceCodes.deviceCode });
    return updated.length;
  }

  private toDomain(row: typeof agentDeviceCodes.$inferSelect): AgentDeviceCode {
    return new AgentDeviceCode({
      deviceCode: row.deviceCode,
      userCode: row.userCode,
      status: row.status as DeviceCodeStatus,
      userId: row.userId ?? null,
      scope: (row.scope as string[] | null) ?? null,
      jwt: row.jwt ?? null,
      denyReason: row.denyReason ?? null,
      requesterMetadata: row.requesterMetadata as RequesterMetadata,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
