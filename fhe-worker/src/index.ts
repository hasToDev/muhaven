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
    const { arbSepolia } = await import('@cofhe/sdk/chains');

    const config = createCofheConfig({
      supportedChains: [arbSepolia],
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
  const result = await cofheClient
    .decryptForTx(handle, fheType)
    .withPermit()
    .execute();
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
  console.log('  POST /api/v1/decrypt/for-tx');
});
