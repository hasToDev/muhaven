import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuthorizeDeviceCodeUseCase,
  IssueDeviceCodeUseCase,
  PollDeviceTokenUseCase,
} from '../device-flow.use-case.js';
import { MemoryAgentDeviceCodeRepository } from '../../../../infrastructure/repository/memory/memory-agent-device-code.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import type { IUserRepository } from '../../../../domain/auth/repository/user.repository.js';
import type { User } from '../../../../domain/auth/model/user.js';

class StubUserRepo implements IUserRepository {
  constructor(private readonly user: User | null) {}
  async findById() {
    return this.user;
  }
  async findByWalletAddress() {
    return this.user;
  }
  async findByWalletAddresses() {
    // Wave 3.5 (Phase 9.A) widened IUserRepository with a batch-lookup
    // helper for investor-listing flows. Device-flow stub returns the
    // single user when present, satisfying the interface without
    // pulling in the batch-lookup behavior the test never exercises.
    return this.user ? [this.user] : [];
  }
  async save() {
    /* no-op */
  }
}

class StubJwtService {
  async generateScopedAccessToken(_payload: unknown, scope: string[], _ttlSec?: number) {
    return {
      accessToken: ['header', JSON.stringify({ scope }), 'sig'].join('.'),
      expiresInSec: 3600,
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
    };
  }
}

const meta = { processName: 'test', hostname: 'h', os: 'linux' };
const stubUser: User = {
  id: 'u1',
  walletAddress: '0xabc',
  walletProvider: 'zerodev',
  role: 'investor',
  createdAt: new Date(),
} as User;

describe('IssueDeviceCodeUseCase', () => {
  it('returns deviceCode + userCode + ttl', async () => {
    const repo = new MemoryAgentDeviceCodeRepository();
    const uc = new IssueDeviceCodeUseCase(repo);
    const out = await uc.execute(meta);
    expect(out.deviceCode).toMatch(/^[a-f0-9]{64}$/);
    expect(out.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(out.expiresInSec).toBe(300);
    expect(out.pollIntervalSec).toBeGreaterThan(0);
  });
});

describe('AuthorizeDeviceCodeUseCase', () => {
  let repo: MemoryAgentDeviceCodeRepository;
  let issue: IssueDeviceCodeUseCase;
  let userRepo: StubUserRepo;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jwt: any;
  let authorize: AuthorizeDeviceCodeUseCase;

  beforeEach(() => {
    repo = new MemoryAgentDeviceCodeRepository();
    issue = new IssueDeviceCodeUseCase(repo);
    userRepo = new StubUserRepo(stubUser);
    jwt = new StubJwtService();
    authorize = new AuthorizeDeviceCodeUseCase(repo, userRepo, jwt);
  });

  it('flips pending → authorized + mints scoped JWT', async () => {
    const issued = await issue.execute(meta);
    const out = await authorize.execute({ userCode: issued.userCode, userId: 'u1' });
    expect(out.deviceCode.status).toBe('authorized');
    expect(out.deviceCode.userId).toBe('u1');
    expect(out.deviceCode.scope).toContain('mcp.read.*');
    expect(out.deviceCode.scope).toContain('mcp.propose.*');
    expect(out.deviceCode.jwt).toBeTruthy();
  });

  it('deny=true flips to denied', async () => {
    const issued = await issue.execute(meta);
    const out = await authorize.execute({ userCode: issued.userCode, userId: 'u1', deny: true });
    expect(out.deviceCode.status).toBe('denied');
  });

  it('rejects malformed userCode', async () => {
    await expect(
      authorize.execute({ userCode: 'invalid', userId: 'u1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 400 (collapsed oracle) for unknown userCode', async () => {
    // Oracle defense — see ADR-3 D4. All non-pending cases collapse to a
    // single 400 so an attacker probing user codes can't distinguish
    // "doesn't exist" vs "already authorized" vs "expired" vs "denied".
    await expect(
      authorize.execute({ userCode: 'AAAA-AAAA', userId: 'u1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects double-authorize as collapsed 400', async () => {
    const issued = await issue.execute(meta);
    await authorize.execute({ userCode: issued.userCode, userId: 'u1' });
    await expect(
      authorize.execute({ userCode: issued.userCode, userId: 'u1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects expired userCode as collapsed 400', async () => {
    const issued = await issue.execute(meta);
    const future = new Date(Date.now() + 600 * 1000);
    await expect(
      authorize.execute({ userCode: issued.userCode, userId: 'u1' }, future),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('PollDeviceTokenUseCase', () => {
  let repo: MemoryAgentDeviceCodeRepository;
  let issue: IssueDeviceCodeUseCase;
  let authorize: AuthorizeDeviceCodeUseCase;
  let poll: PollDeviceTokenUseCase;

  beforeEach(() => {
    repo = new MemoryAgentDeviceCodeRepository();
    issue = new IssueDeviceCodeUseCase(repo);
    authorize = new AuthorizeDeviceCodeUseCase(
      repo,
      new StubUserRepo(stubUser),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new StubJwtService() as any,
    );
    poll = new PollDeviceTokenUseCase(repo);
  });

  it('returns pending before authorize', async () => {
    const issued = await issue.execute(meta);
    const out = await poll.execute(issued.deviceCode);
    expect(out.state).toBe('pending');
  });

  it('returns authorized + jwt + scope after authorize', async () => {
    const issued = await issue.execute(meta);
    await authorize.execute({ userCode: issued.userCode, userId: 'u1' });
    const out = await poll.execute(issued.deviceCode);
    expect(out.state).toBe('authorized');
    expect(out.jwt).toBeTruthy();
    expect(out.scope).toEqual(['mcp.read.*', 'mcp.propose.*']);
  });

  it('returns expired on second poll after consume', async () => {
    const issued = await issue.execute(meta);
    await authorize.execute({ userCode: issued.userCode, userId: 'u1' });
    await poll.execute(issued.deviceCode);
    const out2 = await poll.execute(issued.deviceCode);
    expect(out2.state).toBe('expired');
  });

  it('returns expired for unknown deviceCode (no existence disclosure)', async () => {
    const out = await poll.execute('a'.repeat(64));
    expect(out.state).toBe('expired');
  });

  it('returns denied + reason after deny', async () => {
    const issued = await issue.execute(meta);
    await authorize.execute({
      userCode: issued.userCode,
      userId: 'u1',
      deny: true,
      denyReason: 'wrong device',
    });
    const out = await poll.execute(issued.deviceCode);
    expect(out.state).toBe('denied');
    expect(out.reason).toBe('wrong device');
  });

  it('rejects malformed deviceCode', async () => {
    await expect(poll.execute('not-hex')).rejects.toBeInstanceOf(ApplicationHttpError);
  });

  it('sweeps expired pending row before reading', async () => {
    const issued = await issue.execute(meta);
    // Simulate clock advance past TTL.
    const future = new Date(Date.now() + 600 * 1000);
    const out = await poll.execute(issued.deviceCode, future);
    expect(out.state).toBe('expired');
  });
});
