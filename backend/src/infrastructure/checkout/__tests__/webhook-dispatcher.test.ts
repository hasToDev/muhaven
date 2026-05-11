// `WebhookDispatcher` lazily initialises a logger via `getLogger()`,
// which lazy-loads `getEnv()`. Set JWT_SECRET so the env-schema parse
// succeeds when the suite runs in isolation.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

import { describe, expect, it } from 'vitest';
import {
  WebhookEndpoint,
  WebhookEventType,
  WEBHOOK_ENDPOINT_ID_PREFIX,
} from '../../../domain/checkout/model/webhook-endpoint.js';
import { MemoryWebhookEndpointRepository } from '../../repository/memory/memory-webhook-endpoint.repository.js';
import { MemoryWebhookDeliveryRepository } from '../../repository/memory/memory-webhook-delivery.repository.js';
import { WebhookDispatcher } from '../webhook-dispatcher.js';
import { WebhookSigner, WEBHOOK_SIGNATURE_HEADER_NAME } from '../webhook-signer.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function createFetchStub(responses: Array<{ status: number; body?: string; throw?: Error }>): {
  fetchImpl: typeof fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const r = responses[i++] ?? { status: 200 };
    captured.push({
      url: typeof url === 'string' ? url : url.toString(),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (r.throw) throw r.throw;
    return new Response(r.body ?? '', { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

async function seedEndpoint(repo: MemoryWebhookEndpointRepository, opts: {
  issuerUserId: string;
  enabled?: WebhookEventType[];
  url?: string;
} = { issuerUserId: 'iss_1' }): Promise<WebhookEndpoint> {
  const endpoint = new WebhookEndpoint({
    endpointId: `${WEBHOOK_ENDPOINT_ID_PREFIX}deadbeefdeadbeefdeadbeefdeadbeef`,
    issuerUserId: opts.issuerUserId,
    url: opts.url ?? 'https://example.test/hook',
    // NB: opaque test-only fixture — NOT a real Stripe webhook secret. Prefix
    // deliberately differs from the runtime `whsec_*` format so GitHub secret
    // scanning doesn't false-positive (see https://github.com/hasToDev/muhaven/
    // security/secret-scanning/1). The signer treats the string as raw HMAC
    // key bytes; the wire prefix never affects verification.
    signingSecret: 'TEST_FIXTURE_NOT_A_REAL_SECRET_dispatcher_aaaaaa',
    enabledEvents: opts.enabled ?? [],
    disabledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await repo.issue({ endpoint });
  return endpoint;
}

describe('WebhookDispatcher', () => {
  it('signs the body with the endpoint secret + issuer-bound HMAC', async () => {
    const endpoints = new MemoryWebhookEndpointRepository();
    const deliveries = new MemoryWebhookDeliveryRepository();
    const ep = await seedEndpoint(endpoints, { issuerUserId: 'iss_1' });
    const { fetchImpl, captured } = createFetchStub([{ status: 200, body: 'ok' }]);
    const dispatcher = new WebhookDispatcher(endpoints, deliveries, fetchImpl);

    const result = await dispatcher.dispatch({
      eventType: WebhookEventType.SessionFunded,
      sessionId: 'cs_TESTAAAAAAAAAAAAAAAAAAAAAAAA',
      issuerUserId: 'iss_1',
      payload: { status: 'funded' },
    });

    expect(captured).toHaveLength(1);
    const sigHeader = captured[0].headers[WEBHOOK_SIGNATURE_HEADER_NAME];
    expect(sigHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const verifier = new WebhookSigner();
    expect(
      verifier.verify(ep.signingSecret, new TextEncoder().encode(captured[0].body), sigHeader),
    ).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('delivered');
    expect(result[0].responseStatus).toBe(200);
  });

  it('records a failed delivery on non-2xx response', async () => {
    const endpoints = new MemoryWebhookEndpointRepository();
    const deliveries = new MemoryWebhookDeliveryRepository();
    await seedEndpoint(endpoints);
    const { fetchImpl } = createFetchStub([{ status: 500, body: 'oops' }]);
    const dispatcher = new WebhookDispatcher(endpoints, deliveries, fetchImpl);
    const result = await dispatcher.dispatch({
      eventType: WebhookEventType.SessionFunded,
      sessionId: 'cs_AAAA',
      issuerUserId: 'iss_1',
      payload: {},
    });
    expect(result[0].status).toBe('failed');
    expect(result[0].responseStatus).toBe(500);
    expect(result[0].errorMessage).toMatch(/non-2xx/);
  });

  it('records a failed delivery on fetch throw', async () => {
    const endpoints = new MemoryWebhookEndpointRepository();
    const deliveries = new MemoryWebhookDeliveryRepository();
    await seedEndpoint(endpoints);
    const { fetchImpl } = createFetchStub([{ status: 0, throw: new Error('boom') }]);
    const dispatcher = new WebhookDispatcher(endpoints, deliveries, fetchImpl);
    const result = await dispatcher.dispatch({
      eventType: WebhookEventType.SessionFunded,
      sessionId: 'cs_AAAA',
      issuerUserId: 'iss_1',
      payload: {},
    });
    expect(result[0].status).toBe('failed');
    expect(result[0].errorMessage).toMatch(/boom/);
  });

  it('skips endpoints that do not match the event type', async () => {
    const endpoints = new MemoryWebhookEndpointRepository();
    const deliveries = new MemoryWebhookDeliveryRepository();
    await seedEndpoint(endpoints, {
      issuerUserId: 'iss_1',
      enabled: [WebhookEventType.SessionSettled],
    });
    const { fetchImpl, captured } = createFetchStub([{ status: 200 }]);
    const dispatcher = new WebhookDispatcher(endpoints, deliveries, fetchImpl);
    const result = await dispatcher.dispatch({
      eventType: WebhookEventType.SessionFunded,
      sessionId: 'cs_AAAA',
      issuerUserId: 'iss_1',
      payload: {},
    });
    expect(result).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it('does not deliver to a different issuer', async () => {
    const endpoints = new MemoryWebhookEndpointRepository();
    const deliveries = new MemoryWebhookDeliveryRepository();
    await seedEndpoint(endpoints, { issuerUserId: 'iss_1' });
    const { fetchImpl, captured } = createFetchStub([{ status: 200 }]);
    const dispatcher = new WebhookDispatcher(endpoints, deliveries, fetchImpl);
    const result = await dispatcher.dispatch({
      eventType: WebhookEventType.SessionFunded,
      sessionId: 'cs_AAAA',
      issuerUserId: 'iss_2',
      payload: {},
    });
    expect(result).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it('truncates large response bodies to the cap', async () => {
    const endpoints = new MemoryWebhookEndpointRepository();
    const deliveries = new MemoryWebhookDeliveryRepository();
    await seedEndpoint(endpoints);
    const big = 'x'.repeat(10_000);
    const { fetchImpl } = createFetchStub([{ status: 200, body: big }]);
    const dispatcher = new WebhookDispatcher(endpoints, deliveries, fetchImpl);
    const [delivery] = await dispatcher.dispatch({
      eventType: WebhookEventType.SessionFunded,
      sessionId: 'cs_AAAA',
      issuerUserId: 'iss_1',
      payload: {},
    });
    expect(delivery.responseBodyExcerpt).not.toBeNull();
    expect(delivery.responseBodyExcerpt!.length).toBeLessThanOrEqual(4 * 1024);
  });
});
