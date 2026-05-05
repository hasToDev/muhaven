// `WebhookDispatcher` (used in the setup helper) lazily initialises a
// logger via `getLogger()`. Set JWT_SECRET ahead of the imports so the
// env-schema parse succeeds when the suite runs in isolation.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

import { describe, expect, it } from 'vitest';
import { CreateCheckoutSessionUseCase } from '../create-session.use-case.js';
import { LookupCheckoutSessionUseCase } from '../lookup-session.use-case.js';
import { TransitionCheckoutSessionUseCase } from '../transition-session.use-case.js';
import { MemoryCheckoutSessionRepository } from '../../../../infrastructure/repository/memory/memory-checkout-session.repository.js';
import { MemoryWebhookEndpointRepository } from '../../../../infrastructure/repository/memory/memory-webhook-endpoint.repository.js';
import { MemoryWebhookDeliveryRepository } from '../../../../infrastructure/repository/memory/memory-webhook-delivery.repository.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { SseChannelService } from '../../../../infrastructure/checkout/sse-channel.js';
import { WebhookDispatcher } from '../../../../infrastructure/checkout/webhook-dispatcher.js';
import {
  CheckoutSession,
  CheckoutSessionStatus,
} from '../../../../domain/checkout/model/checkout-session.js';
import { User } from '../../../../domain/auth/model/user.js';

function makeMetadata() {
  return {
    issuerAddress: '0x' + 'a'.repeat(40) as `0x${string}`,
    tokenAddress: '0x' + 'b'.repeat(40) as `0x${string}`,
    tokenSymbol: 'USDX',
    issuerLabel: null,
    description: 'Series A bridge',
    successUrl: null,
    cancelUrl: null,
  };
}

async function setup() {
  const sessionRepo = new MemoryCheckoutSessionRepository();
  const endpointRepo = new MemoryWebhookEndpointRepository();
  const deliveryRepo = new MemoryWebhookDeliveryRepository();
  const sse = new SseChannelService();
  const noopFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
  const dispatcher = new WebhookDispatcher(endpointRepo, deliveryRepo, noopFetch);
  const userRepo = new MemoryUserRepository();
  await userRepo.save(
    new User({
      id: 'iss_1',
      walletAddress: '0x' + '1'.repeat(40),
      walletProvider: 'zerodev',
      role: 'issuer',
      createdAt: new Date(),
      issuerStatus: 'approved',
    }),
  );
  const create = new CreateCheckoutSessionUseCase(sessionRepo, 'https://pay.test', userRepo);
  const transition = new TransitionCheckoutSessionUseCase(sessionRepo, sse, dispatcher);
  return { sessionRepo, sse, transition, create };
}

describe('TransitionCheckoutSessionUseCase', () => {
  it('flips pending → funded with a buyer address', async () => {
    const { create, transition } = await setup();
    const r = await create.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '1' },
    });
    const result = await transition.execute({
      sessionId: r.session.sessionId,
      newStatus: CheckoutSessionStatus.Funded,
      buyerAddress: '0x' + 'c'.repeat(40) as `0x${string}`,
    });
    expect(result.session.status).toBe('funded');
    expect(result.session.buyerAddress).toBe('0x' + 'c'.repeat(40));
  });

  it('rejects funded transition without a buyer address', async () => {
    const { create, transition } = await setup();
    const r = await create.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '1' },
    });
    await expect(
      transition.execute({
        sessionId: r.session.sessionId,
        newStatus: CheckoutSessionStatus.Funded,
      }),
    ).rejects.toThrow(/buyerAddress/);
  });

  it('rejects purchased transition without a tx hash', async () => {
    const { create, transition } = await setup();
    const r = await create.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '1' },
    });
    // First reach wrapped via the legal path.
    await transition.execute({
      sessionId: r.session.sessionId,
      newStatus: CheckoutSessionStatus.Funded,
      buyerAddress: '0x' + 'c'.repeat(40) as `0x${string}`,
    });
    await transition.execute({
      sessionId: r.session.sessionId,
      newStatus: CheckoutSessionStatus.Wrapped,
    });
    await expect(
      transition.execute({
        sessionId: r.session.sessionId,
        newStatus: CheckoutSessionStatus.Purchased,
      }),
    ).rejects.toThrow(/purchaseTxHash/);
  });

  it('rejects an explicit settled transition (backend-only)', async () => {
    const { create, transition } = await setup();
    const r = await create.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '1' },
    });
    await expect(
      transition.execute({
        sessionId: r.session.sessionId,
        newStatus: CheckoutSessionStatus.Settled,
      }),
    ).rejects.toThrow(/settled/);
  });

  it('rejects buyer-driven failed transition (port-time hardening)', async () => {
    // Closes a freeze-vector: the URL is the public capability for
    // pending → funded, but `failed` would let any URL-holder freeze
    // the session out of the funded/wrapped lane. Failed must be
    // backend-only (chain indexer / fault detection).
    const { create, transition } = await setup();
    const r = await create.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '1' },
    });
    await expect(
      transition.execute({
        sessionId: r.session.sessionId,
        newStatus: CheckoutSessionStatus.Failed,
      }),
    ).rejects.toThrow(/failed/);
    // Lane stays open: legit pending → funded still works.
    const ok = await transition.execute({
      sessionId: r.session.sessionId,
      newStatus: CheckoutSessionStatus.Funded,
      buyerAddress: '0x' + 'c'.repeat(40) as `0x${string}`,
    });
    expect(ok.session.status).toBe('funded');
  });

  it('rejects illegal forward transitions (e.g., pending → purchased)', async () => {
    const { create, transition } = await setup();
    const r = await create.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '1' },
    });
    await expect(
      transition.execute({
        sessionId: r.session.sessionId,
        newStatus: CheckoutSessionStatus.Purchased,
        purchaseTxHash: '0x' + '1'.repeat(64),
      }),
    ).rejects.toThrow(/invalid transition/);
  });

  it('publishes an SSE event on each transition', async () => {
    const { create, transition, sse } = await setup();
    const r = await create.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '1' },
    });
    let captured = '';
    const fakeRes = {
      write: (chunk: string) => {
        captured += chunk;
        return true;
      },
      end: () => {
        // no-op
      },
    } as unknown as import('node:http').ServerResponse;
    sse.subscribe(r.session.sessionId, fakeRes);
    await transition.execute({
      sessionId: r.session.sessionId,
      newStatus: CheckoutSessionStatus.Funded,
      buyerAddress: '0x' + 'c'.repeat(40) as `0x${string}`,
    });
    expect(captured).toContain('event: funded');
  });

  it('refuses a transition on a terminal session', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const sse = new SseChannelService();
    const endpointRepo = new MemoryWebhookEndpointRepository();
    const deliveryRepo = new MemoryWebhookDeliveryRepository();
    const noopFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const dispatcher = new WebhookDispatcher(endpointRepo, deliveryRepo, noopFetch);
    const transition = new TransitionCheckoutSessionUseCase(sessionRepo, sse, dispatcher);

    const session = new CheckoutSession({
      sessionId: 'cs_AAAAAAAAAAAAAAAAAAAAAAAAAA',
      issuerUserId: 'iss_1',
      status: CheckoutSessionStatus.Settled,
      metadata: makeMetadata(),
      buyerAddress: null,
      encPayload: 'a:b:c',
      purchaseTxHash: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await sessionRepo.issue({ session });
    // Use Funded as the attempted target — Failed is now rejected by
    // the H1 hardening BEFORE the terminal check fires, so probing the
    // terminal-state guard with Failed would surface "reserved for
    // backend" instead of the "terminal" message we want to assert.
    await expect(
      transition.execute({
        sessionId: session.sessionId,
        newStatus: CheckoutSessionStatus.Funded,
        buyerAddress: '0x' + 'd'.repeat(40) as `0x${string}`,
      }),
    ).rejects.toThrow(/terminal/);
  });
});

describe('LookupCheckoutSessionUseCase', () => {
  it('lazily expires a pending session past its TTL', async () => {
    const { create, sessionRepo } = await setup();
    const lookup = new LookupCheckoutSessionUseCase(sessionRepo);
    const r = await create.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '1' },
    });
    const future = new Date(r.session.expiresAt.getTime() + 1000);
    const found = await lookup.execute({ sessionId: r.session.sessionId, now: future });
    expect(found.status).toBe('expired');
  });

  it('returns 404 for an unknown session id', async () => {
    const { sessionRepo } = await setup();
    const lookup = new LookupCheckoutSessionUseCase(sessionRepo);
    await expect(
      lookup.execute({ sessionId: 'cs_DOESNOTEXISTAAAAAAAAAAAAAA' }),
    ).rejects.toThrow(/not found/);
  });
});
