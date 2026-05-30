/**
 * Backend client for the Telegram bot worker. Calls the Wave 4 P4
 * `/api/v1/agent/openclaw/*` endpoints with the shared service secret.
 */

export interface BackendClientOpts {
  baseUrl: string;
  serviceSecret: string;
  /** Per-request timeout in ms. Default 10s. */
  timeoutMs?: number;
}

export class BackendClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly title: string,
    message?: string,
  ) {
    super(message ?? title);
    this.name = 'BackendClientError';
  }
}

export interface IntentSummary {
  intentId: string;
  kind: 'buy' | 'claim';
  tier: 'inline' | 'mini_app_otp' | 'passkey_deeplink';
  status: string;
  amountUsd6: string;
  intentHash: string;
  expiresAt: string;
}

export interface CreatedIntent {
  intent: IntentSummary;
  /** Only present on mini_app_otp tier — surfaced once. */
  otp?: string;
}

export interface ConsumeLinkResult {
  link: {
    telegramChatId: string;
    userId: string;
    linkedAt: string;
  };
}

export class BackendClient {
  private readonly baseUrl: string;
  private readonly serviceSecret: string;
  private readonly timeoutMs: number;

  constructor(opts: BackendClientOpts) {
    this.baseUrl = opts.baseUrl;
    this.serviceSecret = opts.serviceSecret;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async consumeLinkCode(input: {
    linkCode: string;
    telegramChatId: string;
    telegramUserId: string;
    telegramUsername: string | null;
  }): Promise<ConsumeLinkResult> {
    return this.post<ConsumeLinkResult>('/api/v1/agent/openclaw/link/consume', input);
  }

  /**
   * Wave 5 Option D · C5 — the `/revoke_session` phone kill-switch. The
   * backend resolves the chat to its bound MuHaven user and revokes
   * every active scoped session for that user. Throws `BackendClientError`
   * with status 404 (chat not linked) or 409 (no active session); 200
   * returns `{ revoked, found }`.
   */
  async revokeSessionForChatId(input: {
    telegramChatId: string;
  }): Promise<{ revoked: number; found: number }> {
    return this.post<{ revoked: number; found: number }>(
      '/api/v1/agent/telegram/revoke-session',
      input,
    );
  }

  async createIntent(input: {
    userId: string;
    kind: 'buy' | 'claim';
    amountUsd6: string;
    payload: { token: string; summary: string; issuerLabel?: string; escrowId?: string };
    telegramChatId: string;
  }): Promise<CreatedIntent> {
    return this.post<CreatedIntent>('/api/v1/agent/openclaw/intent/create', input);
  }

  async confirmIntent(input: {
    intentId: string;
    /** Telegram chat.id from the callback_query — backend asserts this
     *  matches the row's `intent.telegramChatId` to defeat C-2 (a
     *  service-secret holder confirming an intent from a different
     *  chat). */
    expectedChatId: string;
    /** Telegram user.id from the callback_query.from — backend asserts
     *  the binding row's `telegramUserId` matches. Defeats group-chat
     *  callback-query attacks where chat.id and user.id diverge. */
    expectedUserId: string;
    source: 'telegram_inline';
  }): Promise<{ intent: IntentSummary }> {
    return this.post<{ intent: IntentSummary }>(
      '/api/v1/agent/openclaw/intent/confirm-inline',
      input,
    );
  }

  async denyIntent(input: {
    intentId: string;
    expectedChatId: string;
    expectedUserId: string;
    reason?: string;
  }): Promise<{ intent: { intentId: string; status: string } }> {
    return this.post<{ intent: { intentId: string; status: string } }>(
      '/api/v1/agent/openclaw/intent/deny-inline',
      input,
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.serviceSecret}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // noop — non-JSON bodies are surfaced via status only.
      }
      if (!res.ok) {
        const title =
          parsed && typeof parsed === 'object' && 'title' in (parsed as Record<string, unknown>)
            ? String((parsed as Record<string, unknown>).title)
            : `backend ${res.status}`;
        throw new BackendClientError(res.status, title, text);
      }
      return parsed as T;
    } finally {
      clearTimeout(t);
    }
  }
}
