import { beforeAll, describe, expect, it } from 'vitest';
import {
  type IOperatorAlertTransport,
  type OperatorAlertPayload,
  OperatorAlertPayloadSchema,
} from '../../../../infrastructure/operator/operator-alert-transport.js';
import { NotifyYieldCronFailureUseCase } from '../notify-yield-cron-failure.use-case.js';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

class CapturingTransport implements IOperatorAlertTransport {
  payloads: OperatorAlertPayload[] = [];
  shouldThrow = false;
  async notify(payload: OperatorAlertPayload): Promise<void> {
    if (this.shouldThrow) throw new Error('transport boom');
    this.payloads.push(payload);
  }
}

describe('NotifyYieldCronFailureUseCase', () => {
  it('sanitises + dispatches an error to the transport', async () => {
    const transport = new CapturingTransport();
    const useCase = new NotifyYieldCronFailureUseCase(transport);

    await useCase.execute({
      err: new (class ZeroRateError extends Error {
        constructor() {
          super('ratePerShare floored to 0; every claim would silent-fail to zero.');
          this.name = 'ZeroRateError';
        }
      })(),
      tokenSymbol: 'USYC',
      epochId: 17n,
    });

    expect(transport.payloads.length).toBe(1);
    const p = transport.payloads[0]!;
    expect(p.tokenSymbol).toBe('USYC');
    expect(p.epochId).toBe(17n);
    expect(p.errorClass).toBe('ZeroRateError');
    expect(p.shortMessage).toContain('floored to 0');
    expect(p.severity).toBe('error');
    // OperatorAlertPayloadSchema must accept the produced payload (the
    // bot worker re-validates a similar shape on the wire; this catches
    // future sanitiser changes that drift past the transport contract).
    expect(() => OperatorAlertPayloadSchema.parse(p)).not.toThrow();
  });

  it('honors severity override', async () => {
    const transport = new CapturingTransport();
    const useCase = new NotifyYieldCronFailureUseCase(transport);

    await useCase.execute({
      err: new Error('NAV stale 6 days'),
      tokenSymbol: 'CETES',
      severity: 'warn',
    });

    expect(transport.payloads[0]?.severity).toBe('warn');
  });

  it('preserves the known token address through the sanitiser', async () => {
    const transport = new CapturingTransport();
    const useCase = new NotifyYieldCronFailureUseCase(transport);
    const KNOWN = '0x1d6C140204F21835F1AF2A0615826A333827d946';

    await useCase.execute({
      err: new Error(`fund failed for token ${KNOWN.toLowerCase()}`),
      tokenSymbol: 'USYC',
      tokenAddress: KNOWN,
    });

    // Round-2 Reality M-3 — sanitiser emits the canonical form
    // (`tokenAddress` arg), NOT the case-shape from the input
    // message. Operator pastes alerts into Etherscan; a preserved
    // wrong-checksum address is a phishing primitive.
    expect(transport.payloads[0]?.shortMessage).toContain(KNOWN);
    expect(transport.payloads[0]?.shortMessage).not.toContain(KNOWN.toLowerCase());
  });

  it('swallows transport rethrows so the cron tick survives', async () => {
    const transport = new CapturingTransport();
    transport.shouldThrow = true;
    const useCase = new NotifyYieldCronFailureUseCase(transport);

    await expect(
      useCase.execute({ err: new Error('boom'), tokenSymbol: 'USYC' }),
    ).resolves.toBeUndefined();
  });

  it('omits epochId from the payload when caller did not supply one', async () => {
    const transport = new CapturingTransport();
    const useCase = new NotifyYieldCronFailureUseCase(transport);

    await useCase.execute({ err: new Error('config-load failure'), tokenSymbol: 'USYC' });

    expect(transport.payloads[0]?.epochId).toBeUndefined();
  });
});
