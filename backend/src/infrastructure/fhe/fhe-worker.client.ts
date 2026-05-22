import type { Logger } from 'pino';
import { getEnv } from '../../core/config.js';
import { getLogger } from '../../core/logger.js';
import { ApplicationHttpError } from '../../core/errors.js';

export interface FheEncryptionItem {
  type: 'euint64' | 'euint128' | 'eaddress' | 'ebool';
  value: string | boolean;
}

export interface FheEncryptedResult {
  type: string;
  data: string;
  securityZone: number;
  utype: number;
  inputProof: string;
  encryptionTimeMs: number;
}

export interface FheBatchResponse {
  results: FheEncryptedResult[];
  totalEncryptionTimeMs: number;
}

export class FheWorkerClient {
  private baseUrl: string;
  private logger: Logger;

  constructor() {
    this.baseUrl = getEnv().FHE_WORKER_URL;
    this.logger = getLogger('FheWorkerClient');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async encryptBatch(userAddress: string, items: FheEncryptionItem[]): Promise<FheBatchResponse> {
    this.logger.info({ userAddress, itemCount: items.length }, 'Encrypting batch via FHE worker');

    const res = await fetch(`${this.baseUrl}/api/v1/encrypt/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAddress, items }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      this.logger.error({ status: res.status, error }, 'FHE worker encryption failed');

      if (res.status === 503) {
        throw ApplicationHttpError.internalError('FHE worker not ready');
      }
      throw ApplicationHttpError.internalError(
        `FHE encryption failed: ${(error as Record<string, string>).detail || res.statusText}`,
      );
    }

    const data = (await res.json()) as FheBatchResponse;
    this.logger.info({ totalTime: data.totalEncryptionTimeMs }, 'FHE batch encryption complete');
    return data;
  }

  /**
   * Wave 5 Path D Slice 1 (Commit 3.5) — encrypt with a hard
   * `setAccount(userAddress)` binding on the cofhe pipeline. Use this
   * variant whenever the on-chain `msg.sender` of the consuming contract
   * is `userAddress` (e.g. the user's kernel calling
   * `subscription.purchase`). See `encryptBatchForAccount` JSDoc in
   * `fhe-worker/src/index.ts` for the verifier-signature semantics and
   * why this lives separately from `encryptBatch`.
   */
  async encryptBatchForAccount(
    userAddress: string,
    items: FheEncryptionItem[],
  ): Promise<FheBatchResponse> {
    this.logger.info(
      { userAddress, itemCount: items.length },
      'Encrypting batch (for-account) via FHE worker',
    );

    // Wave 5 Path D Slice 1 Commit 3.5 (BA-H1 / RC round-2 H-2) — forward
    // `FHE_WORKER_SHARED_SECRET` as `X-FHE-Worker-Secret` header. When
    // unset on either side, the worker accepts all (back-compat); when
    // both sides set the matching value, the worker rejects 401 on a
    // mismatch. Set the env on both sides post-deploy.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const sharedSecret = process.env.FHE_WORKER_SHARED_SECRET;
    if (sharedSecret) {
      headers['X-FHE-Worker-Secret'] = sharedSecret;
    }

    const res = await fetch(`${this.baseUrl}/api/v1/encrypt/for-account`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userAddress, items }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      this.logger.error(
        { status: res.status, error },
        'FHE worker (for-account) encryption failed',
      );

      if (res.status === 503) {
        throw ApplicationHttpError.internalError('FHE worker not ready');
      }
      throw ApplicationHttpError.internalError(
        `FHE encryption (for-account) failed: ${(error as Record<string, string>).detail || (error as Record<string, string>).error || res.statusText}`,
      );
    }

    const data = (await res.json()) as FheBatchResponse;
    this.logger.info(
      { totalTime: data.totalEncryptionTimeMs },
      'FHE batch encryption (for-account) complete',
    );
    return data;
  }

  /**
   * TN-signed `decryptForTx` against the deployed CoFHE TaskManager. Used
   * by Wave 4 P6 `OnChainRiskParamsAdapter.decryptBreachFlag` to lift an
   * `ebool` handle returned by `RiskParams.checkAndExecute` into the
   * `(cleartext, signature)` triple that `settleBreachDecrypt` consumes.
   *
   * Caller-side error policy: transient errors (`Forbidden`,
   * `decrypt request failed`, `timeout`, `unavailable`) are surfaced
   * verbatim so the caller's transient-error matcher can recognize them
   * and retry per the P0 bench DEV_LOG retry budget.
   */
  async decryptForTx(
    ctHash: string,
    fheType: 'ebool' | 'euint8' | 'euint16' | 'euint32' | 'euint64' | 'euint128',
  ): Promise<FheDecryptForTxResponse> {
    this.logger.info({ ctHash, fheType }, 'decryptForTx via FHE worker');

    const res = await fetch(`${this.baseUrl}/api/v1/decrypt/for-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ctHash, fheType }),
      // Bench p99 was ~1.44s; soak-test could be slower under contention.
      // Cap at 30s — anything past that is operationally a TN outage.
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      const message = (error as Record<string, string>).error ?? res.statusText;
      this.logger.warn({ status: res.status, message }, 'FHE worker decryptForTx failed');
      // Re-throw with the upstream message so transient-error pattern matchers
      // in PolicyEngineTickUseCase can recognize TN-side `Forbidden` etc.
      throw new Error(message);
    }

    return (await res.json()) as FheDecryptForTxResponse;
  }
}

export interface FheDecryptForTxResponse {
  ctHash: string;
  decryptedValue: string;
  signature: string;
  durationMs: number;
}
