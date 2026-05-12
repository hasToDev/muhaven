import type { WebhookEndpoint } from '../model/webhook-endpoint.js';

export interface IssueWebhookEndpointInput {
  endpoint: WebhookEndpoint;
}

export interface DisableWebhookEndpointInput {
  endpointId: string;
  issuerUserId: string;
  now: Date;
}

export interface IWebhookEndpointRepository {
  issue(input: IssueWebhookEndpointInput): Promise<void>;
  findById(endpointId: string): Promise<WebhookEndpoint | null>;
  /** Dispatcher-runtime: active endpoints only — drives the deliver loop. */
  findActiveByIssuerUserId(issuerUserId: string): Promise<WebhookEndpoint[]>;
  /** Dashboard list: active + disabled, newest-first. Hint-only signing-secret
   *  surfacing belongs at the use-case layer, NEVER inside the repo. */
  findAllByIssuerUserId(issuerUserId: string): Promise<WebhookEndpoint[]>;
  /** Atomic disable — returns the new row on success, null on a stale guard. */
  disable(input: DisableWebhookEndpointInput): Promise<WebhookEndpoint | null>;
}
