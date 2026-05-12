import { ApplicationHttpError } from '../../../core/errors.js';
import type { WebhookEndpoint } from '../../../domain/checkout/model/webhook-endpoint.js';
import type { IWebhookEndpointRepository } from '../../../domain/checkout/repository/webhook-endpoint.repository.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type {
  ListWebhookEndpointsResponseDto,
  WebhookEndpointListItemDto,
} from '../../dto/checkout/checkout.dto.js';

/**
 * Wave 4 §5 Path D — list issuer's webhook endpoints (active + disabled).
 *
 * Privacy boundary: signing-secret is NEVER returned in full. Only a hint
 * (Stripe-style mask `whsec_xxxxxx…abcd`) so the issuer can recognise
 * which endpoint a stored secret belongs to. The full secret was returned
 * ONCE at register time; subsequent reads MUST use the hint. See
 * `ISSUER_CHECKOUT_DASHBOARD_PLAN.md` §1.A invariant 2.
 */

export interface ListWebhooksInput {
  issuerUserId: string;
}

export class ListWebhooksUseCase {
  constructor(
    private readonly endpointRepo: IWebhookEndpointRepository,
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(input: ListWebhooksInput): Promise<ListWebhookEndpointsResponseDto> {
    const issuer = await this.userRepo.findById(input.issuerUserId);
    if (!issuer || issuer.role !== 'issuer' || issuer.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'Issuer onboarding required before webhooks list',
        { code: 'NOT_APPROVED_ISSUER' },
      );
    }

    const rows = await this.endpointRepo.findAllByIssuerUserId(input.issuerUserId);
    return {
      endpoints: rows.map(toListItem),
    };
  }
}

/**
 * Mask the signing secret. Format: keep the `whsec_` prefix + first 6
 * chars after it + `…` + last 4 chars. For a representative
 * `whsec_d41d8cd98f00b204e9800998ecf8427e`, the hint reads
 * `whsec_d41d8c…427e`. This carries enough entropy for the issuer to
 * disambiguate two endpoints without leaking material that could be
 * combined into a working forgery.
 */
export function maskSigningSecret(secret: string): string {
  // Defensive — production secrets always carry the `whsec_` prefix +
  // 64 hex chars (`generateSigningSecret` returns whsec_<32-byte hex>),
  // so the two `< 14` and `body < 10` branches only fire on test fixtures
  // / migration leftovers. Keep them — strip-on-cleanup would surface
  // raw secrets if a malformed row ever appeared in production.
  if (secret.length < 14) return '***';
  const prefix = secret.startsWith('whsec_') ? 'whsec_' : '';
  const body = secret.slice(prefix.length);
  if (body.length < 10) return `${prefix}***`;
  return `${prefix}${body.slice(0, 6)}…${body.slice(-4)}`;
}

function toListItem(endpoint: WebhookEndpoint): WebhookEndpointListItemDto {
  return {
    endpointId: endpoint.endpointId,
    url: endpoint.url,
    enabledEvents: [...endpoint.enabledEvents],
    signingSecretHint: maskSigningSecret(endpoint.signingSecret),
    disabledAt: endpoint.disabledAt?.toISOString() ?? null,
    createdAt: endpoint.createdAt.toISOString(),
  };
}
