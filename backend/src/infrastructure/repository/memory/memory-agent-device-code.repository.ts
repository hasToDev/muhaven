import type {
  AuthorizeDeviceCodeInput,
  DenyDeviceCodeInput,
  IAgentDeviceCodeRepository,
  IssueDeviceCodeInput,
} from '../../../domain/auth/repository/agent-device-code.repository.js';
import {
  AgentDeviceCode,
  DeviceCodeStatus,
} from '../../../domain/auth/model/agent-device-code.js';

/**
 * In-memory implementation for tests + dev-without-postgres. Mirrors
 * the postgres atomic-update semantics by mutating in place.
 */
export class MemoryAgentDeviceCodeRepository implements IAgentDeviceCodeRepository {
  private rowsByDeviceCode = new Map<string, AgentDeviceCode>();
  private rowsByUserCode = new Map<string, AgentDeviceCode>();

  async issue(input: IssueDeviceCodeInput): Promise<AgentDeviceCode> {
    // Reject collisions on the user-code's pending namespace. Stable
    // `userCode_collision:` prefix so the use-case retry-budget can narrow
    // on collisions only (mirrors PG 23505 on the partial unique index
    // `agent_device_codes_user_code_pending_idx`).
    const existing = this.rowsByUserCode.get(input.userCode);
    if (existing && existing.status === DeviceCodeStatus.Pending) {
      throw new Error(`userCode_collision: ${input.userCode} already in use`);
    }
    const row = new AgentDeviceCode({
      deviceCode: input.deviceCode,
      userCode: input.userCode,
      status: DeviceCodeStatus.Pending,
      userId: null,
      scope: null,
      jwt: null,
      denyReason: null,
      requesterMetadata: input.requesterMetadata,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    });
    this.rowsByDeviceCode.set(input.deviceCode, row);
    this.rowsByUserCode.set(input.userCode, row);
    return row;
  }

  async findByDeviceCode(deviceCode: string): Promise<AgentDeviceCode | null> {
    return this.rowsByDeviceCode.get(deviceCode) ?? null;
  }

  async findByUserCode(userCode: string): Promise<AgentDeviceCode | null> {
    return this.rowsByUserCode.get(userCode) ?? null;
  }

  async authorize(input: AuthorizeDeviceCodeInput): Promise<AgentDeviceCode | null> {
    const row = this.rowsByUserCode.get(input.userCode);
    if (!row) return null;
    if (row.status !== DeviceCodeStatus.Pending) return null;
    if (row.expiresAt.getTime() <= input.now.getTime()) return null;
    return this.replace(
      row,
      new AgentDeviceCode({
        ...row,
        status: DeviceCodeStatus.Authorized,
        userId: input.userId,
        scope: input.scope,
        jwt: input.jwt,
        updatedAt: input.now,
      }),
    );
  }

  async deny(input: DenyDeviceCodeInput): Promise<AgentDeviceCode | null> {
    const row = this.rowsByUserCode.get(input.userCode);
    if (!row) return null;
    if (row.status !== DeviceCodeStatus.Pending) return null;
    return this.replace(
      row,
      new AgentDeviceCode({
        ...row,
        status: DeviceCodeStatus.Denied,
        userId: input.userId,
        denyReason: input.reason ?? null,
        updatedAt: input.now,
      }),
    );
  }

  async consume(deviceCode: string, now: Date): Promise<{ jwt: string; scope: string[] } | null> {
    const row = this.rowsByDeviceCode.get(deviceCode);
    if (!row) return null;
    if (row.status !== DeviceCodeStatus.Authorized) return null;
    if (!row.jwt) return null;
    const jwt = row.jwt;
    const scope = row.scope ?? [];
    this.replace(
      row,
      new AgentDeviceCode({ ...row, status: DeviceCodeStatus.Consumed, jwt: null, updatedAt: now }),
    );
    return { jwt, scope };
  }

  async sweepExpired(now: Date): Promise<number> {
    let count = 0;
    for (const row of this.rowsByDeviceCode.values()) {
      const inFlight =
        row.status === DeviceCodeStatus.Pending || row.status === DeviceCodeStatus.Authorized;
      if (inFlight && row.expiresAt.getTime() <= now.getTime()) {
        this.replace(
          row,
          new AgentDeviceCode({
            ...row,
            status: DeviceCodeStatus.Expired,
            jwt: null,
            updatedAt: now,
          }),
        );
        count++;
      }
    }
    return count;
  }

  private replace(prev: AgentDeviceCode, next: AgentDeviceCode): AgentDeviceCode {
    this.rowsByDeviceCode.set(prev.deviceCode, next);
    this.rowsByUserCode.set(prev.userCode, next);
    return next;
  }
}
