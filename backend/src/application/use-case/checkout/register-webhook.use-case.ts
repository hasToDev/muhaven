import { randomBytes } from 'node:crypto';
import { ApplicationHttpError } from '../../../core/errors.js';
import {
  WebhookEndpoint,
  WEBHOOK_ENDPOINT_ID_PREFIX,
  type WebhookEventType,
} from '../../../domain/checkout/model/webhook-endpoint.js';
import type { IWebhookEndpointRepository } from '../../../domain/checkout/repository/webhook-endpoint.repository.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import { generateSigningSecret } from '../../../infrastructure/checkout/webhook-signer.js';

/**
 * Register a webhook endpoint for an issuer (Wave 4 P5).
 *
 * Returns the freshly-minted signing secret ONCE — caller is responsible
 * for storing it. Subsequent reads will only return the truncated
 * "secret hint" (first 8 chars + …) so a leaked dashboard read can't
 * complete a forgery.
 *
 * Wave 4 ships create + disable; Wave 5 dashboard adds rotate / list /
 * test-fire admin endpoints.
 */

export interface RegisterWebhookEndpointInput {
  issuerUserId: string;
  url: string;
  /** Subset of event types — empty array means "all events". */
  enabledEvents?: readonly WebhookEventType[];
  now?: Date;
}

export interface RegisterWebhookEndpointResult {
  endpoint: WebhookEndpoint;
  /**
   * The full signing secret — surfaced ONCE. Caller stores in a secure
   * place (env var, secret manager). The repo persists it directly so
   * future deliveries can sign.
   */
  signingSecret: string;
}

export class RegisterWebhookEndpointUseCase {
  constructor(
    private readonly endpointRepo: IWebhookEndpointRepository,
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(
    input: RegisterWebhookEndpointInput,
  ): Promise<RegisterWebhookEndpointResult> {
    // Phase 9.A · F2 onboarding gate (port-time fix). Same shape as
    // `CreateCheckoutSessionUseCase` — mirrors the F2 lifecycle gate
    // already enforced on `DeployTokenUseCase.start`. An unapproved
    // issuer-roled user could otherwise register a webhook URL that
    // would receive Stripe-style signed deliveries the moment any
    // future approved-issuer flow created a session for that user
    // (e.g., during a KYB-suspension lift).
    const issuer = await this.userRepo.findById(input.issuerUserId);
    if (!issuer || issuer.role !== 'issuer' || issuer.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'Issuer onboarding required before webhook registration',
        { code: 'NOT_APPROVED_ISSUER' },
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw ApplicationHttpError.badRequest('webhook url must be a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw ApplicationHttpError.badRequest(
        'webhook url must be http:// or https://',
      );
    }
    if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
      throw ApplicationHttpError.badRequest(
        'http:// is only allowed for localhost (test); production endpoints must use https://',
      );
    }
    // SSRF guard — block https:// targets pointing at private / loopback
    // hostnames so a compromised issuer JWT can't enumerate the homelab
    // network or hit AWS metadata endpoints. Loopback `http://localhost`
    // is allowed above as a deliberate test convenience.
    if (parsed.protocol === 'https:' && isPrivateOrLoopback(parsed.hostname)) {
      throw ApplicationHttpError.badRequest(
        'webhook url must not point at a private / loopback host',
      );
    }
    if (input.enabledEvents && input.enabledEvents.length > 32) {
      throw ApplicationHttpError.badRequest(
        'enabledEvents must contain ≤32 entries',
      );
    }

    const now = input.now ?? new Date();
    const signingSecret = generateSigningSecret();
    const endpointId = generateWebhookEndpointId();
    const endpoint = new WebhookEndpoint({
      endpointId,
      issuerUserId: input.issuerUserId,
      url: input.url,
      signingSecret,
      enabledEvents: input.enabledEvents ?? [],
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.endpointRepo.issue({ endpoint });
    return { endpoint, signingSecret };
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * Cleartext IP-class checks. Hostnames that aren't IP literals (e.g.,
 * `internal-api.example.test`) are treated as PUBLIC at registration
 * time — the runtime DNS resolver can still betray us, so a Wave 5
 * dispatcher hardening pass should resolve and re-check at delivery
 * time. Wave 4 ships the obvious-IP-literal block.
 */
function isPrivateOrLoopback(hostname: string): boolean {
  if (isLoopback(hostname)) return true;
  // Strip optional brackets around IPv6.
  const h = hostname.replace(/^\[|\]$/g, '');
  // Common-case IPv4 private ranges.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  // IPv6 literals — match `fc..` / `fd..` (ULA), `fe80..` (link-local),
  // and `::1`.
  if (/^fc[0-9a-f]{2}:/i.test(h)) return true;
  if (/^fd[0-9a-f]{2}:/i.test(h)) return true;
  if (/^fe80:/i.test(h)) return true;
  if (h === '::') return true;
  return false;
}

/**
 * Endpoint-id generator. Mirrors `generateSessionId` in
 * create-session.use-case so the shape stays uniform across the §5
 * Path D dashboard surface (`cs_<26>` + `whe_<26>` both Crockford
 * base32, no IO0L lookalikes).
 *
 * §5 walkthrough operator-side bug 2026-05-1?: pre-fix this minted
 * `whe_<32 lowercase hex>` via `randomBytes(16).toString('hex')`,
 * which mismatched `WEBHOOK_ENDPOINT_ID_RE = /^whe_[A-Z0-9]{26}$/`
 * on BOTH length (32 vs 26) and alphabet (lowercase hex vs uppercase
 * Crockford). The list endpoint returned those malformed ids; the
 * disable DTO 422'd on Zod regex check when the frontend echoed them
 * back. The id alphabet check is load-bearing — it prevents IO0L
 * confusion in audit logs and dashboards.
 */
const WEBHOOK_ENDPOINT_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function generateWebhookEndpointId(): string {
  const buf = randomBytes(26);
  let out = '';
  for (const b of buf) {
    out += WEBHOOK_ENDPOINT_ID_ALPHABET[b % WEBHOOK_ENDPOINT_ID_ALPHABET.length];
  }
  return WEBHOOK_ENDPOINT_ID_PREFIX + out;
}
