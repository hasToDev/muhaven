/**
 * Tiny line-based IPC client used by the MCP server to talk to a
 * running `muhaven-broker` daemon. Mirrors the protocol in
 * `src/broker/protocol.ts`.
 *
 * One request per connection; response is a single line. Connection
 * timeouts surface as `BrokerClientError` with a stable `code` string so
 * the MCP tool layer can map to host-friendly error responses without
 * inspecting message strings.
 */

import { connect, type Socket } from 'node:net';
import type {
  BrokerGetJwtResponse,
  BrokerHelloResponse,
  BrokerResponse,
  BrokerSignHashResponse,
  BrokerStoreJwtResponse,
} from '../broker/protocol.js';

export type BrokerClientErrorCode =
  | 'connect_failed'
  | 'timeout'
  | 'protocol_error'
  | 'broker_error';

export class BrokerClientError extends Error {
  constructor(
    readonly code: BrokerClientErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BrokerClientError';
  }
}

export interface BrokerClientOptions {
  endpoint: string;
  timeoutMs: number;
}

export class BrokerClient {
  constructor(private readonly options: BrokerClientOptions) {}

  async hello(): Promise<BrokerHelloResponse> {
    const res = await this.exchange({ type: 'hello' });
    if (res.type !== 'hello') {
      throw new BrokerClientError('protocol_error', `expected hello response, got ${res.type}`);
    }
    return res;
  }

  async signHash(
    hash: `0x${string}`,
    intent?: { tool: string; summary?: string },
  ): Promise<BrokerSignHashResponse> {
    const res = await this.exchange({
      type: 'sign_hash',
      hash,
      ...(intent ? { intent } : {}),
    });
    if (res.type !== 'sign_hash') {
      throw new BrokerClientError(
        'protocol_error',
        `expected sign_hash response, got ${res.type}`,
      );
    }
    return res;
  }

  async storeJwt(jwt: string, expiresAtSec?: number): Promise<BrokerStoreJwtResponse> {
    const res = await this.exchange({
      type: 'store_jwt',
      jwt,
      ...(expiresAtSec === undefined ? {} : { expiresAtSec }),
    });
    if (res.type !== 'store_jwt') {
      throw new BrokerClientError(
        'protocol_error',
        `expected store_jwt response, got ${res.type}`,
      );
    }
    return res;
  }

  async getJwt(): Promise<BrokerGetJwtResponse> {
    const res = await this.exchange({ type: 'get_jwt' });
    if (res.type !== 'get_jwt') {
      throw new BrokerClientError(
        'protocol_error',
        `expected get_jwt response, got ${res.type}`,
      );
    }
    return res;
  }

  async clearJwt(): Promise<void> {
    const res = await this.exchange({ type: 'clear_jwt' });
    if (res.type !== 'clear_jwt') {
      throw new BrokerClientError(
        'protocol_error',
        `expected clear_jwt response, got ${res.type}`,
      );
    }
  }

  private exchange(request: Record<string, unknown>): Promise<BrokerResponse> {
    return new Promise<BrokerResponse>((resolve, reject) => {
      let socket: Socket | undefined;
      let buffer = '';
      let settled = false;

      const settleErr = (err: BrokerClientError): void => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        reject(err);
      };

      const settleOk = (res: BrokerResponse): void => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        resolve(res);
      };

      const timer = setTimeout(() => {
        settleErr(new BrokerClientError('timeout', 'broker IPC timeout'));
      }, this.options.timeoutMs);

      try {
        socket = connect(this.options.endpoint);
      } catch (err) {
        clearTimeout(timer);
        settleErr(new BrokerClientError('connect_failed', 'cannot connect to broker', err));
        return;
      }

      socket.once('connect', () => {
        socket!.write(JSON.stringify(request) + '\n');
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx < 0) return;
        const line = buffer.slice(0, newlineIdx);
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(line) as BrokerResponse;
          if (parsed.type === 'error') {
            settleErr(
              new BrokerClientError('broker_error', `${parsed.code}: ${parsed.message}`),
            );
            return;
          }
          settleOk(parsed);
        } catch (err) {
          settleErr(new BrokerClientError('protocol_error', 'invalid JSON from broker', err));
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        settleErr(new BrokerClientError('connect_failed', err.message, err));
      });

      socket.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settleErr(new BrokerClientError('protocol_error', 'broker closed without response'));
        }
      });
    });
  }
}
