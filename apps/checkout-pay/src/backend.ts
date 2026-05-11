/**
 * Tiny backend client for the hosted-checkout buyer page (Wave 4 P5).
 *
 * The page calls three endpoints over the same nagreg origin:
 *  - `POST /api/v1/checkout/sessions/lookup` — fetch metadata + ciphertext.
 *  - `POST /api/v1/checkout/sessions/transition` — flip status forward.
 *  - `GET  /api/v1/checkout/sessions/events?sessionId=<id>` — SSE channel.
 */

const DEFAULT_BASE = (() => {
  // Vite's `import.meta.env.VITE_BACKEND_URL` is the production override;
  // hostname-based heuristic gives the demo a single-build deploy without
  // env files.
  const envBase = (import.meta as ImportMeta & { env?: Record<string, string> })
    .env?.VITE_BACKEND_URL;
  if (envBase) return envBase;
  if (typeof window !== 'undefined' && /(^|\.)pay-stage\.muhaven\.app$/i.test(window.location.host)) {
    return 'https://api-stage.muhaven.app';
  }
  if (typeof window !== 'undefined' && /(^|\.)pay\.muhaven\.app$/i.test(window.location.host)) {
    return 'https://api.muhaven.app';
  }
  return 'http://localhost:3000';
})();

export interface CheckoutSessionDto {
  sessionId: string;
  status: string;
  encPayload: string;
  metadata: {
    issuerAddress: string;
    tokenAddress: string;
    tokenSymbol: string;
    issuerLabel: string | null;
    description: string;
    successUrl: string | null;
    cancelUrl: string | null;
  };
  buyerAddress: string | null;
  purchaseTxHash: string | null;
  expiresAt: string;
  createdAt: string;
}

export class BackendError extends Error {
  constructor(
    public readonly status: number,
    public readonly title: string,
    public readonly detail?: string,
  ) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'BackendError';
  }
}

export class CheckoutBackend {
  constructor(private readonly baseUrl: string = DEFAULT_BASE) {}

  async lookupSession(sessionId: string): Promise<CheckoutSessionDto> {
    return this.post('/api/v1/checkout/sessions/lookup', { sessionId });
  }

  async transition(input: {
    sessionId: string;
    newStatus: 'funded' | 'wrapped' | 'purchased' | 'failed';
    buyerAddress?: string;
    purchaseTxHash?: string;
  }): Promise<CheckoutSessionDto> {
    return this.post('/api/v1/checkout/sessions/transition', input);
  }

  /** Returns the EventSource — caller responsible for adding listeners. */
  openEventStream(sessionId: string): EventSource {
    const url = new URL(`${this.baseUrl}/api/v1/checkout/sessions/events`);
    url.searchParams.set('sessionId', sessionId);
    return new EventSource(url.toString(), { withCredentials: false });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new BackendError(res.status, res.statusText, detail ?? undefined);
    }
    return res.json() as Promise<T>;
  }
}

async function safeReadText(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}
