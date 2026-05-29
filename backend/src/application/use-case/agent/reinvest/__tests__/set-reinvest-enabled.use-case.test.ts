import { describe, it, expect, vi } from 'vitest';
import { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import type { IScopedSessionRepository } from '../../../../../domain/agent/repository/scoped-session.repository.js';
import { SetReinvestEnabledUseCase } from '../set-reinvest-enabled.use-case.js';

const USER = 'user-uuid-1';
const NOW = new Date('2026-05-29T12:00:00.000Z');

function session(enabled: boolean): ScopedSession {
  return new ScopedSession({
    sessionId: 's1',
    userId: USER,
    surface: Surface.MCP,
    status: ScopedSessionStatus.Active,
    signerAddress: '0x9999999999999999999999999999999999999999',
    permissionId: null,
    targetContracts: [],
    selectorCaps: [],
    maxPerOpUsd6: 0n,
    totalSpentUsd6: 0n,
    validUntilSec: Math.floor(NOW.getTime() / 1000) + 3600,
    mintedAtSec: Math.floor(NOW.getTime() / 1000),
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: NOW,
    revokedAt: null,
    expiredAt: null,
    reinvestEnabled: enabled,
  });
}

describe('SetReinvestEnabledUseCase', () => {
  it('toggles the flag on the active session and returns it', async () => {
    const setSpy = vi.fn(async () => session(true));
    const repo = { setReinvestEnabled: setSpy } as unknown as IScopedSessionRepository;
    const uc = new SetReinvestEnabledUseCase(repo);
    const out = await uc.execute({ userId: USER, enabled: true, now: NOW });
    expect(out.reinvestEnabled).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(USER, Surface.MCP, true, NOW);
  });

  it('throws 404 when there is no active session to toggle', async () => {
    const repo = {
      setReinvestEnabled: vi.fn(async () => null),
    } as unknown as IScopedSessionRepository;
    const uc = new SetReinvestEnabledUseCase(repo);
    await expect(
      uc.execute({ userId: USER, enabled: true, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('can disable (false) too', async () => {
    const setSpy = vi.fn(async () => session(false));
    const repo = { setReinvestEnabled: setSpy } as unknown as IScopedSessionRepository;
    const uc = new SetReinvestEnabledUseCase(repo);
    const out = await uc.execute({ userId: USER, enabled: false, now: NOW });
    expect(out.reinvestEnabled).toBe(false);
    expect(setSpy).toHaveBeenCalledWith(USER, Surface.MCP, false, NOW);
  });
});
