import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface EncryptionItem {
  type: 'euint64' | 'euint128' | 'eaddress' | 'ebool';
  value: string | boolean;
}

interface EncryptedResult {
  type: string;
  data: string;
  securityZone: number;
  utype: number;
  inputProof: string;
  encryptionTimeMs: number;
}

let cofheClient: any = null;
let initPromise: Promise<void> | null = null;
let ready = false;

async function initializeCofhe(): Promise<void> {
  if (cofheClient) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = doInitialize();
  await initPromise;
}

async function doInitialize(): Promise<void> {
  try {
    const { createCofheConfig, createCofheClient } = await import('@cofhe/sdk/node');
    const { getChainById } = await import('@cofhe/sdk/chains');

    // 2026-05-23: bumped @cofhe/sdk 0.4.0 → 0.5.1 (CLAUDE.md project
    // standard; every other consumer is on 0.5.1). The 0.4.0
    // initialization path read `SubtleCrypto.generateKey(...).keyPair`
    // which is undefined under Node's WebCrypto shim, throwing
    // `TypeError: Cannot read properties of undefined (reading
    // 'keyPair')` from `GenerateSealingKey` and silently flipping
    // `cofheClient` to null → every encrypt downstream returned 500
    // `CoFHE client not initialized`. The 0.5.x `environment: 'node'`
    // flag selects the Node-native sealing-key generation path and
    // mirrors backend `node-cofhe-client.ts:68-71`'s working pattern.
    const chain = getChainById(421614); // Arb Sepolia — only chain wired today
    if (!chain) {
      throw new Error('No CoFHE chain configuration found for chainId 421614');
    }

    const config = createCofheConfig({
      environment: 'node',
      supportedChains: [chain],
    });

    cofheClient = createCofheClient(config);

    // Note: connect() requires publicClient + walletClient.
    // For the worker, we create a minimal viem setup.
    const { createPublicClient, createWalletClient, http } = await import('viem');
    const { arbitrumSepolia } = await import('viem/chains');
    const { privateKeyToAccount } = await import('viem/accounts');

    const rpcUrl = process.env.RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc';
    const privateKey = process.env.FHE_WORKER_PRIVATE_KEY || process.env.PRIVATE_KEY;

    if (!privateKey) {
      console.warn('No private key configured for FHE worker — encryption will fail until key is set');
      ready = true;
      return;
    }

    const account = privateKeyToAccount(privateKey as `0x${string}`);

    const publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
      account,
      chain: arbitrumSepolia,
      transport: http(rpcUrl),
    });

    await cofheClient.connect(publicClient, walletClient);

    // Seed a fresh self-permit at init. `decryptForTx(...).withPermit()` (with
    // no args) resolves to the active permit; in Node the cofhe permit store
    // is in-memory so the very first call without this seed would throw
    // "Active permit not found". `ensureFreshSelfPermit` also closes the
    // long-lived-process gap: `getOrCreateSelfPermit` does NOT verify the
    // permit's `expiration`, so on a worker that runs longer than the SDK
    // default 7d TTL the active permit would stale-out and every decrypt
    // would throw "Permit is expired" with no recovery.
    await ensureFreshSelfPermit(cofheClient);

    ready = true;
    console.log('CoFHE client initialized successfully');
  } catch (error) {
    console.error('CoFHE initialization failed:', error);
    cofheClient = null;
    initPromise = null;
    ready = true; // Mark ready even on failure so health check doesn't hang
  }
}

interface DecryptForTxResult {
  ctHash: string;
  decryptedValue: string;
  signature: string;
  durationMs: number;
}

/**
 * Detect the cofhe SDK's "Permit is expired" / "not signed" / "invalid"
 * surface. `decryptForTx(...).withPermit().execute()` runs
 * `PermitUtils.validate(permit)` which calls
 * `ValidationUtils.assertSignedAndNotExpired(permit)` — that throws a
 * generic `Error` with one of these messages when the active permit's
 * `expiration` (default 7d) is in the past. Catching and refreshing keeps
 * a long-lived worker honest beyond a single permit's lifetime.
 */
function isExpiredPermitError(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e);
  return /Permit is (expired|not signed|invalid)/i.test(raw);
}

/**
 * Seed or refresh the active self-permit on the cofhe client.
 *
 * The published `client.permits.getOrCreateSelfPermit()` only checks
 * `(activePermit && activePermit.type === 'self')` — it returns expired
 * permits as-is (per the Fhenix dev's own warning, and the source at
 * `cofhesdk/packages/sdk/core/permits.ts:123-142`). The trap is then
 * sprung at decrypt time. This wrapper closes the gap by inspecting
 * `ValidationUtils.isExpired` and re-signing via `createSelf` when stale.
 */
async function ensureFreshSelfPermit(client: any): Promise<void> {
  const { ValidationUtils } = await import('@cofhe/sdk/permits');
  const permit = await client.permits.getOrCreateSelfPermit();
  if (!ValidationUtils.isExpired(permit)) return;
  await client.permits.removeActivePermit();
  await client.permits.createSelf({ issuer: permit.issuer });
}

async function decryptForTx(
  ctHash: string,
  fheTypeName: 'ebool' | 'euint8' | 'euint16' | 'euint32' | 'euint64' | 'euint128',
): Promise<DecryptForTxResult> {
  if (!cofheClient) {
    throw new Error('CoFHE client not initialized');
  }

  // The cofhe SDK FheTypes enum uses non-prefixed names: Bool / Uint8 / Uint16
  // / Uint32 / Uint64 / Uint128 / Uint160. Translate from the wire-format
  // `e*` names which match the Solidity types our callers think in terms of.
  const FHE_TYPE_NAME_MAP: Record<string, string> = {
    ebool: 'Bool',
    euint8: 'Uint8',
    euint16: 'Uint16',
    euint32: 'Uint32',
    euint64: 'Uint64',
    euint128: 'Uint128',
  };
  const sdkTypeKey = FHE_TYPE_NAME_MAP[fheTypeName];
  if (!sdkTypeKey) {
    throw new Error(`Unsupported FHE type: ${fheTypeName}`);
  }

  const { FheTypes } = await import('@cofhe/sdk');
  const fheType = (FheTypes as Record<string, unknown>)[sdkTypeKey];
  if (fheType === undefined) {
    throw new Error(`SDK FheTypes enum missing key: ${sdkTypeKey}`);
  }

  const start = Date.now();
  // ctHash arrives as hex (`0x...`); the SDK accepts a bigint.
  const handle = BigInt(ctHash);
  const runDecrypt = () =>
    cofheClient
      .decryptForTx(handle, fheType)
      .withPermit()
      .execute();

  let result;
  try {
    result = await runDecrypt();
  } catch (e) {
    if (!isExpiredPermitError(e)) throw e;
    // Stale active permit — refresh once and retry. Only one retry; if a
    // freshly-signed permit is still rejected, surface the error.
    await ensureFreshSelfPermit(cofheClient);
    result = await runDecrypt();
  }
  const durationMs = Date.now() - start;

  return {
    ctHash,
    decryptedValue:
      typeof result.decryptedValue === 'bigint'
        ? result.decryptedValue.toString()
        : String(result.decryptedValue),
    signature: result.signature,
    durationMs,
  };
}

async function encryptBatch(
  userAddress: string,
  items: EncryptionItem[],
): Promise<{ results: EncryptedResult[]; totalEncryptionTimeMs: number }> {
  if (!cofheClient) {
    throw new Error('CoFHE client not initialized');
  }

  const { Encryptable } = await import('@cofhe/sdk');
  const startTime = Date.now();

  const encryptables = items.map((item) => {
    switch (item.type) {
      case 'euint64':
        return Encryptable.uint64(BigInt(item.value as string));
      case 'euint128':
        return Encryptable.uint128(BigInt(item.value as string));
      case 'eaddress':
        return Encryptable.address(String(item.value));
      case 'ebool':
        return Encryptable.bool(Boolean(item.value));
      default:
        throw new Error(`Unsupported type: ${item.type}`);
    }
  });

  const encrypted = await cofheClient.encryptInputs(encryptables).execute();
  const totalEncryptionTimeMs = Date.now() - startTime;

  const results: EncryptedResult[] = (encrypted as any[]).map((enc, i) => ({
    type: items[i].type,
    data: '0x' + enc.ctHash.toString(16).padStart(64, '0'),
    securityZone: enc.securityZone,
    utype: enc.utype,
    inputProof: enc.signature,
    encryptionTimeMs: Math.round(totalEncryptionTimeMs / items.length),
  }));

  return { results, totalEncryptionTimeMs };
}

const ADDRESS_HEX_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_LC = '0x0000000000000000000000000000000000000000';
/**
 * Defensive ceiling on encrypt-batch input size. A malicious peer with
 * network reach to the worker can today ask for unbounded items. We
 * never legitimately need > 50 in one batch (real callers ask for 1-3).
 */
const MAX_BATCH_ITEMS = 50;
const ALLOWED_ITEM_TYPES: ReadonlySet<EncryptionItem['type']> = new Set([
  'euint64',
  'euint128',
  'eaddress',
  'ebool',
]);

/**
 * Wave 5 Path D Slice 1 Commit 3.5 (BA-H1 / RC-H2 reality check) —
 * shared-secret gate on the new `/api/v1/encrypt/for-account` endpoint.
 *
 * Backend forwards `FHE_WORKER_SHARED_SECRET` in the `X-FHE-Worker-Secret`
 * header. Worker rejects requests whose header doesn't match. Legacy
 * `/api/v1/encrypt/batch` is intentionally NOT gated — Wave 3 flows
 * predate this; rotating them is a separate concern. The `for-account`
 * endpoint is new and ships with the gate from day one.
 *
 * When the secret env-var is UNSET on the worker, the gate accepts ALL
 * callers (back-compat for ops who haven't rotated their env yet). Best
 * practice is to set the env on both sides post-deploy.
 */
const FHE_WORKER_SHARED_SECRET = process.env.FHE_WORKER_SHARED_SECRET;

/**
 * Wave 5 Path D Slice 1 Commit 3.5 (SecEng round-2 MED-4) — serialize
 * `encryptInputs(...).setAccount(...).execute()` across the singleton
 * `cofheClient`. `setAccount` mutates client state in-flight; two
 * parallel `/for-account` requests for distinct kernel addresses can
 * race and bind kernel A's encryption under kernel B's setAccount.
 *
 * Per-account serialization would be ideal; conservative pessimistic
 * lock (one-at-a-time) is simpler and acceptable for Slice 1's
 * single-user workload. Promise-chain pattern: each request awaits the
 * previous tail before starting, then becomes the new tail.
 */
let _encryptForAccountTail: Promise<unknown> = Promise.resolve();
function serializeForAccount<T>(fn: () => Promise<T>): Promise<T> {
  const next = _encryptForAccountTail.then(fn, fn);
  // Never let a rejection poison the chain — subsequent calls must
  // proceed even if a prior one threw.
  _encryptForAccountTail = next.catch(() => undefined);
  return next;
}

/**
 * Wave 5 Path D Slice 1 (Commit 3.5) — encrypt with a hard `setAccount`
 * binding to `userAddress`.
 *
 * The cofhe verifier signs each ciphertext over
 * `(ctHash, utype, securityZone, msg.sender, chainId)` where `msg.sender`
 * is the address bound via `setAccount(...)`. The on-chain TaskManager's
 * `extractSigner` then validates that signature against the actual
 * `msg.sender` of the executing contract. For Path D, the executing
 * `msg.sender` is the user's kernel — NOT the fhe-worker's own EOA — so
 * the encrypt step MUST `setAccount(kernelAddress)` or the on-chain
 * verify reverts `InvalidSigner` (selector `0x7ba5ffb5`).
 *
 * Kept as a sibling of `encryptBatch` (not a flag on it) so the Wave 3
 * legacy escrow flow — which works today only because `msg.sender ==
 * fhe-worker EOA` happens to match the verifier signer — stays exactly
 * as it is. Future fixes to the legacy path can opt in by switching to
 * this endpoint.
 */
async function encryptBatchForAccount(
  userAddress: string,
  items: EncryptionItem[],
): Promise<{ results: EncryptedResult[]; totalEncryptionTimeMs: number }> {
  if (!cofheClient) {
    throw new Error('CoFHE client not initialized');
  }
  if (!ADDRESS_HEX_RE.test(userAddress)) {
    throw new Error(`userAddress must be a 0x-prefixed 20-byte hex string (got ${JSON.stringify(userAddress)})`);
  }
  if (userAddress.toLowerCase() === ZERO_ADDRESS_LC) {
    throw new Error('userAddress must not be the zero address');
  }
  // Defense-in-depth — the use-case caps batch size at the application
  // layer too, but a direct caller to the worker (cross-container) can
  // bypass that. Enforce here so OOM via 10k-item blob isn't possible.
  if (items.length > MAX_BATCH_ITEMS) {
    throw new Error(`items.length must be <= ${MAX_BATCH_ITEMS} (got ${items.length})`);
  }
  for (const item of items) {
    if (!ALLOWED_ITEM_TYPES.has(item.type)) {
      throw new Error(`unsupported item type: ${JSON.stringify(item.type)}`);
    }
  }

  const { Encryptable } = await import('@cofhe/sdk');
  const startTime = Date.now();

  const encryptables = items.map((item) => {
    switch (item.type) {
      case 'euint64':
        return Encryptable.uint64(BigInt(item.value as string));
      case 'euint128':
        return Encryptable.uint128(BigInt(item.value as string));
      case 'eaddress':
        return Encryptable.address(String(item.value));
      case 'ebool':
        return Encryptable.bool(Boolean(item.value));
      default:
        throw new Error(`Unsupported type: ${item.type}`);
    }
  });

  // Lowercase the address before passing to setAccount — the verifier's
  // signature is over the bytes we send, but on-chain msg.sender is the
  // EntryPoint's normalized value. Mismatch would yield InvalidSigner.
  // Handler-side already lowercases accountAddress; mirror here so the
  // boundary is consistent (AI Engineer L-1).
  //
  // Serialize the encrypt+setAccount via `serializeForAccount` — see the
  // const JSDoc above for why concurrent calls would otherwise corrupt
  // the singleton cofheClient's setAccount state (SecEng round-2 MED-4).
  const encrypted = await serializeForAccount(() =>
    cofheClient
      .encryptInputs(encryptables)
      .setAccount(userAddress.toLowerCase())
      .execute(),
  );
  const totalEncryptionTimeMs = Date.now() - startTime;

  const results: EncryptedResult[] = (encrypted as any[]).map((enc, i) => ({
    type: items[i].type,
    data: '0x' + enc.ctHash.toString(16).padStart(64, '0'),
    securityZone: enc.securityZone,
    utype: enc.utype,
    inputProof: enc.signature,
    encryptionTimeMs: Math.round(totalEncryptionTimeMs / items.length),
  }));

  return { results, totalEncryptionTimeMs };
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

const port = Number(process.env.PORT) || 3001;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null);
    return;
  }

  // Health check
  if (url.pathname === '/health/ready' && req.method === 'GET') {
    sendJson(res, 200, { status: ready ? 'ready' : 'initializing' });
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, { status: 'ok', ready });
    return;
  }

  // Decrypt-for-tx (TN-signed, on-chain-verifiable)
  if (url.pathname === '/api/v1/decrypt/for-tx' && req.method === 'POST') {
    try {
      await initializeCofhe();

      const body = (await parseBody(req)) as { ctHash?: string; fheType?: string };

      if (!body?.ctHash || !body?.fheType) {
        sendJson(res, 400, { error: 'Invalid request: ctHash and fheType required' });
        return;
      }

      const result = await decryptForTx(
        body.ctHash,
        body.fheType as 'ebool' | 'euint8' | 'euint16' | 'euint32' | 'euint64' | 'euint128',
      );
      sendJson(res, 200, result);
    } catch (error: any) {
      console.error('Decrypt-for-tx failed:', error);
      const message = error?.message ?? 'decrypt-for-tx failed';
      // Surface "Forbidden" / "decrypt request failed" / "timeout" / "unavailable"
      // verbatim so the backend's transient-error matcher can recognize and
      // retry per the P0 bench DEV_LOG retry policy.
      sendJson(res, 500, { error: message });
    }
    return;
  }

  // Encrypt batch
  if (url.pathname === '/api/v1/encrypt/batch' && req.method === 'POST') {
    try {
      await initializeCofhe();

      const body = (await parseBody(req)) as { userAddress: string; items: EncryptionItem[] };

      if (!body?.userAddress || !Array.isArray(body?.items) || body.items.length === 0) {
        sendJson(res, 400, { error: 'Invalid request: userAddress and items[] required' });
        return;
      }

      const result = await encryptBatch(body.userAddress, body.items);
      sendJson(res, 200, result);
    } catch (error: any) {
      console.error('Encryption failed:', error);
      sendJson(res, 500, { error: error.message || 'Encryption failed' });
    }
    return;
  }

  // Encrypt batch with hard `setAccount(userAddress)` binding (Wave 5
  // Path D Slice 1 Commit 3.5). See `encryptBatchForAccount` JSDoc for
  // why this is a sibling of `/api/v1/encrypt/batch` rather than a flag.
  if (url.pathname === '/api/v1/encrypt/for-account' && req.method === 'POST') {
    try {
      // Shared-secret gate (BA-H1 / RC round-2 H-2). When env is set,
      // require the header to match. When unset, allow all (back-compat
      // posture for ops who haven't rotated env). The legacy
      // `/api/v1/encrypt/batch` endpoint is intentionally NOT gated.
      if (FHE_WORKER_SHARED_SECRET) {
        const provided = req.headers['x-fhe-worker-secret'];
        const providedStr = Array.isArray(provided) ? provided[0] : provided;
        if (providedStr !== FHE_WORKER_SHARED_SECRET) {
          sendJson(res, 401, { error: 'invalid X-FHE-Worker-Secret header' });
          return;
        }
      }

      await initializeCofhe();

      const body = (await parseBody(req)) as { userAddress: string; items: EncryptionItem[] };

      if (!body?.userAddress || !Array.isArray(body?.items) || body.items.length === 0) {
        sendJson(res, 400, { error: 'Invalid request: userAddress and items[] required' });
        return;
      }

      const result = await encryptBatchForAccount(body.userAddress, body.items);
      sendJson(res, 200, result);
    } catch (error: any) {
      console.error('Encryption (for-account) failed:', error);
      sendJson(res, 500, { error: error.message || 'Encryption failed' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

// Start initialization eagerly
initializeCofhe().catch((err) => console.error('Background init failed:', err));

server.listen(port, () => {
  console.log(`FHE worker running at http://localhost:${port}`);
  console.log('Endpoints:');
  console.log('  GET  /health/ready');
  console.log('  GET  /health');
  console.log('  POST /api/v1/encrypt/batch');
  console.log('  POST /api/v1/encrypt/for-account');
  console.log('  POST /api/v1/decrypt/for-tx');
});
