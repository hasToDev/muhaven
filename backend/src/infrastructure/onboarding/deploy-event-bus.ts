/**
 * Phase 9.A · Expansion (F2) — in-process SSE channel registry.
 *
 * The deploy library runs **inside the same Node process** as the HTTP
 * server (not a worker). This bus brokers progress events between the
 * background `deployToken()` invocation and the SSE GET endpoint:
 *
 *   POST /v1/issuer/tokens/deploy        → kick off, register channel
 *   library progress callback             → bus.publish(deployId, event)
 *   GET  /v1/issuer/tokens/deploy/:id/events  → bus.subscribe(deployId)
 *
 * Every event is also persisted to `issuer_token_deploys.last_step` so a
 * client that drops + reconnects can poll the row state. The bus is
 * therefore **best-effort low-latency**, not a durable queue.
 *
 * Single-process scope: a horizontal scale-out would require Redis pub/
 * sub here. Acceptable for hackathon (one backend container per env).
 */
import { EventEmitter } from 'node:events';
import type { DeployStepKey } from '../../domain/issuer-onboarding/model/issuer-token-deploy.js';
import type { Hex, Address } from 'viem';

export type DeployEventStatus = 'pending' | 'sent' | 'mined' | 'succeeded' | 'failed';

export interface DeployEvent {
  step: DeployStepKey | 'finalize';
  status: DeployEventStatus;
  txHash?: Hex;
  contractAddress?: Address;
  /** Final terminal payload — set on `finalize` events. */
  resultTokenAddress?: Address;
  errorMessage?: string;
  ts: string;
}

export type DeployEventListener = (event: DeployEvent) => void;

class DeployEventBus {
  private readonly emitter = new EventEmitter();
  /**
   * Recent events buffered per deploy id, so a late SSE subscriber gets
   * everything that happened before they connected. Cleared by
   * `cleanup(deployId)` after the row is finalised + the SSE channel
   * has had a moment to drain.
   */
  private readonly recent = new Map<string, DeployEvent[]>();
  private readonly maxBufferSize = 100;

  publish(deployId: string, event: DeployEvent): void {
    const buf = this.recent.get(deployId) ?? [];
    buf.push(event);
    if (buf.length > this.maxBufferSize) {
      buf.splice(0, buf.length - this.maxBufferSize);
    }
    this.recent.set(deployId, buf);
    this.emitter.emit(`deploy:${deployId}`, event);
  }

  /**
   * Subscribe to a deploy's event stream. The listener is called
   * synchronously for every buffered event first (so a reconnecting
   * client doesn't lose history), then for every new event until
   * `unsubscribe(...)` is called.
   *
   * Returns an unsubscribe function; the caller MUST call it on socket
   * close to avoid leaking listeners.
   */
  subscribe(deployId: string, listener: DeployEventListener): () => void {
    for (const event of this.recent.get(deployId) ?? []) {
      listener(event);
    }
    const wrapped = (event: DeployEvent) => listener(event);
    this.emitter.on(`deploy:${deployId}`, wrapped);
    return () => this.emitter.off(`deploy:${deployId}`, wrapped);
  }

  /** Drop the buffered history for a deploy. Call once both terminal event + SSE drain happened. */
  cleanup(deployId: string): void {
    this.recent.delete(deployId);
  }
}

export const deployEventBus = new DeployEventBus();
