/**
 * Phase 9.A · Expansion (F2) — backend-callable port of
 * `scripts/onboard-token.ts`. Deploys a single RWA token's per-token
 * stack (Token + Queue + Treasury), wires every cross-contract pointer,
 * configures the issuer-controlled oracle, and registers the token in
 * `TokenRegistry` with the **applicant** as the on-chain `MUHAVEN_ISSUER`.
 *
 * Architectural posture:
 *   - **viem-only**, no ethers + no hardhat-upgrades. Pre-compiled
 *     artifacts (impl bytecode + ABI) are read from a configured
 *     directory and `TransparentUpgradeableProxy` is deployed manually
 *     via the standard `(impl, initialOwner, initData)` constructor.
 *   - The caller (HTTP layer) supplies the **platform deployer** signer
 *     — same private key shape as `FHE_WORKER_PRIVATE_KEY`. The signer
 *     pays gas + signs every tx; the **applicant kernel** becomes the
 *     registered `MUHAVEN_ISSUER` atomically (via
 *     `tokenRegistry.registerToken(token, { issuer: applicant, … })`).
 *   - Oracle kind is hard-locked to `issuer` for self-serve. Chainlink
 *     stays operator-only via `pnpm hardhat run scripts/onboard-token.ts`.
 *   - Token is registered **paused** because the deployer ≠ navWriter
 *     (applicant is). The wizard's step 6 prompts the kernel for a
 *     post-deploy `oracle.setNAV` + `tokenRegistry.setPaused(false)`
 *     — those are NOT done here.
 *   - Treasury seed is skipped (deployer doesn't hold legacy PUSDC for
 *     a self-serve flow). Issuer funds the treasury post-deploy.
 *
 * The library exposes a `(step, status, txHash?) => void` progress
 * callback shape that mirrors `MuHavenClient.ProgressCallback` from the
 * SDK so the HTTP SSE bridge is a 1:1 forward.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../../core/logger.js';
import {
  DEPLOY_STEPS,
  type DeployStepKey,
} from '../../domain/issuer-onboarding/model/issuer-token-deploy.js';

export type ProgressStatus = 'pending' | 'sent' | 'mined';

export interface DeployProgressEvent {
  step: DeployStepKey;
  status: ProgressStatus;
  txHash?: Hex;
  contractAddress?: Address;
}

export type DeployProgressCallback = (event: DeployProgressEvent) => void | Promise<void>;

export interface DeployTokenInput {
  /** Token symbol (3-8 chars uppercase, pre-checked unique). */
  symbol: string;
  /** Token display name. */
  name: string;
  /**
   * Applicant kernel address — registered as `MUHAVEN_ISSUER` in
   * TokenRegistry, granted NAV-writer rights on the oracle, owns
   * treasury.
   */
  applicant: Address;
  /** Initial NAV in PUSDC base units / share (the oracle is paused-on-deploy because deployer ≠ navWriter, so this is a wizard-recorded hint, not a setNAV value). */
  initialNav: bigint;
  /** Cleartext min-investment hint. */
  minInvestment: bigint;
  /** Per-epoch instant redeem cap (PUSDC base units). */
  instantRedeemCap: bigint;
  /** Epoch duration in seconds. */
  epochDuration: number;
}

export interface PlatformAddresses {
  subscription: Address;
  tokenRegistry: Address;
  investorRegistry: Address;
  yieldSnapshot: Address;
  identityRegistry: Address;
  modularCompliance: Address;
  stable: Address;
  issuerOracle: Address;
  kycAdapter: Address;
}

export interface DeployTokenLibraryConfig {
  rpcUrl: string;
  /** 0x-prefixed 32-byte hex of the platform deployer EOA. */
  deployerPrivateKey: Hex;
  platform: PlatformAddresses;
  /** Directory containing the project's compiled `contracts/` artifacts. */
  artifactsDir: string;
}

export interface DeployTokenResult {
  tokenAddress: Address;
  treasuryAddress: Address;
  queueAddress: Address;
  registeredOracle: Address;
  txHashes: Record<DeployStepKey, Hex[]>;
}

interface CompiledArtifact {
  abi: Abi;
  bytecode: Hex;
}

/**
 * Resolve the pre-compiled artifact JSON for one of MuHaven's contracts.
 * `artifactsDir` is expected to point at the project's compiled
 * `artifacts/` root (Hardhat layout: `<artifactsDir>/contracts/<File>.sol/<Name>.json`).
 */
function loadArtifact(artifactsDir: string, contractName: string): CompiledArtifact {
  const path = join(artifactsDir, 'contracts', `${contractName}.sol`, `${contractName}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as { abi: Abi; bytecode: string };
  return { abi: raw.abi, bytecode: raw.bytecode as Hex };
}

/**
 * Resolve the OpenZeppelin TransparentUpgradeableProxy artifact. OZ
 * ships pre-compiled JSON in `@openzeppelin/contracts/build/contracts/`
 * — we read it via require.resolve so pnpm hoisting / bun symlinks /
 * Docker bake-in all resolve identically.
 */
function loadTupArtifact(): CompiledArtifact {
  // Resolve relative to the package — works in dev (`pnpm install`),
  // in production (npm-style flat install), and in the backend image
  // (the `node_modules/` layer carries `@openzeppelin/contracts`).
  const tupPath =
    '@openzeppelin/contracts/build/contracts/TransparentUpgradeableProxy.json';
  const resolved = createRequire(import.meta.url).resolve(tupPath);
  const raw = JSON.parse(readFileSync(resolved, 'utf-8')) as {
    abi: Abi;
    bytecode: string;
  };
  return { abi: raw.abi, bytecode: raw.bytecode as Hex };
}

const logger = getLogger('DeployTokenLibrary');

export class DeployTokenLibrary {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly deployerAccount: ReturnType<typeof privateKeyToAccount>;
  private readonly platform: PlatformAddresses;
  private readonly tokenArtifact: CompiledArtifact;
  private readonly queueArtifact: CompiledArtifact;
  private readonly treasuryArtifact: CompiledArtifact;
  private readonly tupArtifact: CompiledArtifact;

  constructor(config: DeployTokenLibraryConfig) {
    this.deployerAccount = privateKeyToAccount(config.deployerPrivateKey);
    this.publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.walletClient = createWalletClient({
      account: this.deployerAccount,
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.platform = config.platform;
    this.tokenArtifact = loadArtifact(config.artifactsDir, 'MuHavenToken');
    this.queueArtifact = loadArtifact(config.artifactsDir, 'RedemptionQueue');
    this.treasuryArtifact = loadArtifact(config.artifactsDir, 'MuHavenTreasury');
    this.tupArtifact = loadTupArtifact();
  }

  /**
   * Pre-flight check: make sure the symbol isn't already used by a
   * registered token. Walks the registry once and reads each token's
   * `symbol()` view. Returns the matching address if found, null
   * otherwise.
   */
  async findExistingTokenBySymbol(symbol: string): Promise<Address | null> {
    const registered = (await this.publicClient.readContract({
      address: this.platform.tokenRegistry,
      abi: tokenRegistryViewAbi,
      functionName: 'getRegisteredTokens',
      args: [0n, 1000n],
    })) as Address[];

    const target = symbol.trim().toUpperCase();
    for (const addr of registered) {
      try {
        const sym = (await this.publicClient.readContract({
          address: addr,
          abi: tokenSymbolViewAbi,
          functionName: 'symbol',
        })) as string;
        if (sym.trim().toUpperCase() === target) return addr;
      } catch {
        // Skip unreadable entries — best-effort scan, not a guarantee.
      }
    }
    return null;
  }

  async deploy(
    input: DeployTokenInput,
    onProgress: DeployProgressCallback,
  ): Promise<DeployTokenResult> {
    const txHashes = Object.fromEntries(
      DEPLOY_STEPS.map((s) => [s, [] as Hex[]]),
    ) as unknown as Record<DeployStepKey, Hex[]>;

    const advance = async (
      step: DeployStepKey,
      status: ProgressStatus,
      extra?: { txHash?: Hex; contractAddress?: Address },
    ) => {
      if (extra?.txHash) txHashes[step].push(extra.txHash);
      try {
        await onProgress({ step, status, ...extra });
      } catch (err) {
        // Progress callbacks must NEVER abort the deploy. The HTTP
        // layer handles SSE failures separately.
        logger.warn({ err, step, status }, 'Progress callback threw');
      }
    };

    // ── Step 1: MuHavenToken proxy ──────────────────────────────────────
    await advance('deploy_token', 'pending');
    const tokenInitData = encodeFunctionData({
      abi: this.tokenArtifact.abi,
      functionName: 'initialize',
      args: [
        input.name,
        input.symbol,
        this.platform.kycAdapter,
        this.platform.investorRegistry,
        input.applicant,
        '0x0000000000000000000000000000000000000000', // _usdcAddress placeholder
      ],
    });
    const tokenAddress = await this.deployBehindProxy(
      this.tokenArtifact,
      tokenInitData,
      'deploy_token',
      advance,
    );

    // ── Step 2: RedemptionQueue proxy ──────────────────────────────────
    await advance('deploy_queue', 'pending');
    const queueInitData = encodeFunctionData({
      abi: this.queueArtifact.abi,
      functionName: 'initialize',
      args: [
        this.deployerAccount.address, // _owner — platform deployer (later admin)
        tokenAddress,
        this.platform.tokenRegistry,
        this.platform.subscription,
        this.platform.stable,
      ],
    });
    const queueAddress = await this.deployBehindProxy(
      this.queueArtifact,
      queueInitData,
      'deploy_queue',
      advance,
    );

    // ── Step 3: MuHavenTreasury proxy ──────────────────────────────────
    await advance('deploy_treasury', 'pending');
    const treasuryInitData = encodeFunctionData({
      abi: this.treasuryArtifact.abi,
      functionName: 'initialize',
      args: [
        tokenAddress,
        this.platform.subscription,
        queueAddress,
        input.applicant, // issuer_
        this.platform.stable,
        0n, // minFloat_ default
        this.deployerAccount.address, // owner_
      ],
    });
    const treasuryAddress = await this.deployBehindProxy(
      this.treasuryArtifact,
      treasuryInitData,
      'deploy_treasury',
      advance,
    );

    // ── Step 4: Wire MuHavenToken pointers ─────────────────────────────
    await advance('wire_token_pointers', 'pending');
    await this.sendAndAwait(
      'wire_token_pointers',
      tokenAddress,
      this.tokenArtifact.abi,
      'setSubscription',
      [this.platform.subscription],
      advance,
    );
    await this.sendAndAwait(
      'wire_token_pointers',
      tokenAddress,
      this.tokenArtifact.abi,
      'setQueue',
      [queueAddress],
      advance,
    );
    await this.sendAndAwait(
      'wire_token_pointers',
      tokenAddress,
      this.tokenArtifact.abi,
      'setYieldSnapshot',
      [this.platform.yieldSnapshot],
      advance,
    );
    await this.sendAndAwait(
      'wire_token_pointers',
      tokenAddress,
      this.tokenArtifact.abi,
      'setIdentityRegistry',
      [this.platform.identityRegistry],
      advance,
    );
    await this.sendAndAwait(
      'wire_token_pointers',
      tokenAddress,
      this.tokenArtifact.abi,
      'setModularCompliance',
      [this.platform.modularCompliance],
      advance,
    );
    // The queue's `cancelOnKYCRevocation` reads identityRegistry.isVerified
    // directly per ADR-027; pointer must be wired here too.
    await this.sendAndAwait(
      'wire_token_pointers',
      queueAddress,
      this.queueArtifact.abi,
      'setIdentityRegistry',
      [this.platform.identityRegistry],
      advance,
    );
    await advance('wire_token_pointers', 'mined');

    // ── Step 5: InvestorRegistry — authorise the new token ─────────────
    await advance('authorize_investor_registry', 'pending');
    await this.sendAndAwait(
      'authorize_investor_registry',
      this.platform.investorRegistry,
      investorRegistryAuthAbi,
      'setAuthorizedCaller',
      [tokenAddress, true],
      advance,
    );
    await advance('authorize_investor_registry', 'mined');

    // ── Step 6: ModularCompliance state-hook callers (ADR-032) ─────────
    await advance('authorize_compliance_callers', 'pending');
    await this.sendAndAwait(
      'authorize_compliance_callers',
      this.platform.modularCompliance,
      modularComplianceAuthAbi,
      'setAuthorizedCaller',
      [tokenAddress, tokenAddress, true],
      advance,
    );
    await this.sendAndAwait(
      'authorize_compliance_callers',
      this.platform.modularCompliance,
      modularComplianceAuthAbi,
      'setAuthorizedCaller',
      [tokenAddress, this.platform.subscription, true],
      advance,
    );
    // Phase 7.6 atomic settlement requires queue authorisation too —
    // see `onboard-token.ts:347` for the historical incident note.
    await this.sendAndAwait(
      'authorize_compliance_callers',
      this.platform.modularCompliance,
      modularComplianceAuthAbi,
      'setAuthorizedCaller',
      [tokenAddress, queueAddress, true],
      advance,
    );
    await advance('authorize_compliance_callers', 'mined');

    // ── Step 7: Configure IssuerControlledOracle ───────────────────────
    await advance('configure_oracle', 'pending');
    // Default deviation gate (matches script default of 250 bps = 2.5%).
    await this.sendAndAwait(
      'configure_oracle',
      this.platform.issuerOracle,
      oracleConfigAbi,
      'setMaxDeviationBps',
      [tokenAddress, 250n],
      advance,
    );
    await this.sendAndAwait(
      'configure_oracle',
      this.platform.issuerOracle,
      oracleConfigAbi,
      'setNavWriter',
      [tokenAddress, input.applicant],
      advance,
    );
    // Initial NAV write deferred to wizard step 6 — applicant signs
    // `setNAV(initialNav)` from their kernel after deploy completes.
    await advance('configure_oracle', 'mined');

    // ── Step 8: TokenRegistry.registerToken ────────────────────────────
    // Token is registered PAUSED because deployer ≠ navWriter, so the
    // oracle still has nav=0. Wizard step 6 unpauses post-setNAV.
    await advance('register_token', 'pending');
    const registerHash = await this.walletClient.writeContract({
      account: this.deployerAccount,
      chain: arbitrumSepolia,
      address: this.platform.tokenRegistry,
      abi: tokenRegistryRegisterAbi,
      functionName: 'registerToken',
      args: [
        tokenAddress,
        {
          active: true,
          treasury: treasuryAddress,
          queue: queueAddress,
          oracle: this.platform.issuerOracle,
          issuer: input.applicant,
          minInvestment: input.minInvestment,
          instantRedeemCap: input.instantRedeemCap,
          epochDuration: input.epochDuration,
          paused: true,
        },
      ],
    });
    await advance('register_token', 'sent', { txHash: registerHash });
    await this.publicClient.waitForTransactionReceipt({ hash: registerHash });
    await advance('register_token', 'mined', {
      txHash: registerHash,
      contractAddress: tokenAddress,
    });

    return {
      tokenAddress,
      treasuryAddress,
      queueAddress,
      registeredOracle: this.platform.issuerOracle,
      txHashes,
    };
  }

  /**
   * Deploy a contract behind a TransparentUpgradeableProxy. The
   * deployer is set as `initialOwner` (proxy admin); the wizard
   * doesn't expose a transfer-admin path today (it stays as platform
   * deployer for upgradeability). Returns the proxy address.
   */
  private async deployBehindProxy(
    artifact: CompiledArtifact,
    initData: Hex,
    step: DeployStepKey,
    advance: (
      step: DeployStepKey,
      status: ProgressStatus,
      extra?: { txHash?: Hex; contractAddress?: Address },
    ) => Promise<void>,
  ): Promise<Address> {
    // Step A: deploy implementation
    const implHash = await this.walletClient.deployContract({
      account: this.deployerAccount,
      chain: arbitrumSepolia,
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [],
    });
    await advance(step, 'sent', { txHash: implHash });
    const implReceipt = await this.publicClient.waitForTransactionReceipt({
      hash: implHash,
    });
    if (!implReceipt.contractAddress) {
      throw new Error(`Implementation deploy receipt missing contractAddress (step ${step})`);
    }
    const implAddress = implReceipt.contractAddress as Address;

    // Step B: deploy TUP with (impl, initialOwner, initData)
    const proxyHash = await this.walletClient.deployContract({
      account: this.deployerAccount,
      chain: arbitrumSepolia,
      abi: this.tupArtifact.abi,
      bytecode: this.tupArtifact.bytecode,
      args: [implAddress, this.deployerAccount.address, initData],
    });
    await advance(step, 'sent', { txHash: proxyHash });
    const proxyReceipt = await this.publicClient.waitForTransactionReceipt({
      hash: proxyHash,
    });
    if (!proxyReceipt.contractAddress) {
      throw new Error(`Proxy deploy receipt missing contractAddress (step ${step})`);
    }
    const proxyAddress = proxyReceipt.contractAddress as Address;
    await advance(step, 'mined', {
      txHash: proxyHash,
      contractAddress: proxyAddress,
    });
    return proxyAddress;
  }

  private async sendAndAwait(
    step: DeployStepKey,
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    advance: (
      step: DeployStepKey,
      status: ProgressStatus,
      extra?: { txHash?: Hex; contractAddress?: Address },
    ) => Promise<void>,
  ): Promise<Hex> {
    const hash = await this.walletClient.writeContract({
      account: this.deployerAccount,
      chain: arbitrumSepolia,
      address,
      abi,
      functionName,
      args: args as readonly unknown[],
    } as Parameters<WalletClient['writeContract']>[0]);
    await advance(step, 'sent', { txHash: hash });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }
}

/**
 * Resolve the artifacts directory at runtime. Honours
 * `MUHAVEN_ARTIFACTS_DIR` (set in the backend image to the baked-in
 * path) and falls back to walking up from the lib file to the project
 * root's `artifacts/` for local `pnpm dev` use.
 */
export function resolveArtifactsDir(): string {
  if (process.env.MUHAVEN_ARTIFACTS_DIR) {
    return resolve(process.env.MUHAVEN_ARTIFACTS_DIR);
  }
  // From `backend/src/infrastructure/onboarding/deploy-token.library.ts`
  // walk up four levels to project root, then into `artifacts`.
  const here = fileURLToPath(import.meta.url);
  return resolve(here, '..', '..', '..', '..', '..', 'artifacts');
}

// ── Inline ABIs for cross-contract reads/writes ─────────────────────────
// These contracts are deployed once at platform-init; the deploy lib
// just calls them. Inline shapes match the audited interfaces; widening
// requires updating both this lib and the source contract.

const tokenRegistryViewAbi: Abi = [
  {
    type: 'function',
    name: 'getRegisteredTokens',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'address[]' }],
  },
];

const tokenRegistryRegisterAbi: Abi = [
  {
    type: 'function',
    name: 'registerToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      {
        name: 'config',
        type: 'tuple',
        components: [
          { name: 'active', type: 'bool' },
          { name: 'treasury', type: 'address' },
          { name: 'queue', type: 'address' },
          { name: 'oracle', type: 'address' },
          { name: 'issuer', type: 'address' },
          { name: 'minInvestment', type: 'uint128' },
          { name: 'instantRedeemCap', type: 'uint128' },
          { name: 'epochDuration', type: 'uint32' },
          { name: 'paused', type: 'bool' },
        ],
      },
    ],
    outputs: [],
  },
];

const tokenSymbolViewAbi: Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
];

const investorRegistryAuthAbi: Abi = [
  {
    type: 'function',
    name: 'setAuthorizedCaller',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'caller', type: 'address' },
      { name: 'authorized', type: 'bool' },
    ],
    outputs: [],
  },
];

const modularComplianceAuthAbi: Abi = [
  {
    type: 'function',
    name: 'setAuthorizedCaller',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'caller', type: 'address' },
      { name: 'authorized', type: 'bool' },
    ],
    outputs: [],
  },
];

const oracleConfigAbi: Abi = [
  {
    type: 'function',
    name: 'setMaxDeviationBps',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'newMaxDeviationBps', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setNavWriter',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'newWriter', type: 'address' },
    ],
    outputs: [],
  },
];
