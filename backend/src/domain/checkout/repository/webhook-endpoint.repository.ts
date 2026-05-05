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
  findActiveByIssuerUserId(issuerUserId: string): Promise<WebhookEndpoint[]>;
  /** Atomic disable — returns the new row on success, null on a stale guard. */
  disable(input: DisableWebhookEndpointInput): Promise<WebhookEndpoint | null>;
}
