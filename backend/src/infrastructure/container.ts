import {
  MemoryNonceRepository,
  MemoryUserRepository,
  MemorySessionRepository,
  MemoryEscrowRepository,
  MemoryWithdrawalRepository,
  MemoryEscrowEventRepository,
  MemoryYieldRecordRepository,
  MemoryAgentStateRepository,
  MemoryAgentAuditRepository,
  MemoryAgentCronStateRepository,
  MemoryAgentConfirmTokenRepository,
  MemoryAgentDeviceCodeRepository,
  MemoryOpenClawIntentRepository,
  MemoryTelegramLinkCodeRepository,
  MemoryTelegramLinkRepository,
  MemoryCheckoutSessionRepository,
  MemoryWebhookEndpointRepository,
  MemoryWebhookDeliveryRepository,
} from './repository/memory/index.js';
import {
  PgNonceRepository,
  PgUserRepository,
  PgSessionRepository,
  PgEscrowRepository,
  PgWithdrawalRepository,
  PgEscrowEventRepository,
  PgPortfolioRepository,
  PgYieldRecordRepository,
  PgRwaTokenRepository,
  PgNavHistoryRepository,
  PgOracleRepository,
  PgTaxEventRepository,
  PgIssuerTokenDeployRepository,
  PgAgentStateRepository,
  PgAgentAuditRepository,
  PgAgentCronStateRepository,
  PgAgentConfirmTokenRepository,
  PgAgentDeviceCodeRepository,
  PgOpenClawIntentRepository,
  PgTelegramLinkCodeRepository,
  PgTelegramLinkRepository,
  PgCheckoutSessionRepository,
  PgWebhookEndpointRepository,
  PgWebhookDeliveryRepository,
} from './repository/postgres/index.js';
import { getDb } from './repository/postgres/db.js';
import { JwtService } from './auth/jwt.service.js';
import { NonceService } from './auth/nonce.service.js';
import { SiweVerifier } from './auth/siwe-verifier.js';
import { FheService } from './fhe/fhe.service.js';
import { QuickNodeVerifier } from './webhook/quicknode-verifier.js';
import {
  DeployTokenLibrary,
  resolveArtifactsDir,
} from './onboarding/deploy-token.library.js';
import {
  IssuerOracleNavWriterService,
  type IIssuerOracleNavWriter,
} from './oracle/issuer-oracle-nav-writer.service.js';
import { getEnv } from '../core/config.js';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { INonceRepository } from '../domain/nonce/repository/nonce.repository.js';
import type { IUserRepository } from '../domain/auth/repository/user.repository.js';
import type { ISessionRepository } from '../domain/auth/repository/session.repository.js';
import type { IEscrowRepository } from '../domain/escrow/repository/escrow.repository.js';
import type { IWithdrawalRepository } from '../domain/withdrawal/repository/withdrawal.repository.js';
import type { IEscrowEventRepository } from '../domain/escrow/events/repository/escrow-event.repository.js';
import type { IPortfolioRepository } from '../domain/portfolio/repository/portfolio.repository.js';
import type { IYieldRecordRepository } from '../domain/yield-history/repository/yield-record.repository.js';
import type { IRwaTokenRepository } from '../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../domain/nav-history/repository/nav-history.repository.js';
import type { IOracleRepository } from '../domain/oracle/repository/oracle.repository.js';
import type { ITaxEventRepository } from '../domain/tax-event/repository/tax-event.repository.js';
import type { IIssuerTokenDeployRepository } from '../domain/issuer-onboarding/repository/issuer-token-deploy.repository.js';
import type { IAgentStateRepository } from '../domain/agent/repository/agent-state.repository.js';
import type { IAgentAuditRepository } from '../domain/agent/repository/agent-audit.repository.js';
import type { IAgentCronStateRepository } from '../domain/agent/repository/agent-cron-state.repository.js';
import type { IAgentConfirmTokenRepository } from '../domain/agent/repository/agent-confirm-token.repository.js';
import type { IAgentDeviceCodeRepository } from '../domain/auth/repository/agent-device-code.repository.js';
import type { IOpenClawIntentRepository } from '../domain/agent/repository/openclaw-intent.repository.js';
import type {
  ITelegramLinkCodeRepository,
  ITelegramLinkRepository,
} from '../domain/agent/repository/telegram-link.repository.js';
import type { ICheckoutSessionRepository } from '../domain/checkout/repository/checkout-session.repository.js';
import type { IWebhookEndpointRepository } from '../domain/checkout/repository/webhook-endpoint.repository.js';
import type { IWebhookDeliveryRepository } from '../domain/checkout/repository/webhook-delivery.repository.js';
import { SseChannelService } from './checkout/sse-channel.js';
import { WebhookDispatcher } from './checkout/webhook-dispatcher.js';
import {
  ChainedIssuerLabelResolver,
  KybIssuerLabelResolver,
  StaticIssuerLabelResolver,
  StubIssuerLabelResolver,
  type IIssuerLabelResolver,
} from './checkout/issuer-label-resolver.js';
import {
  ChatLlmService,
  ToolDispatcher,
  type IChatLlmService,
} from './agent/index.js';
import {
  PortfolioSummaryToolUseCase,
  QuoteToolUseCase,
  ProposeBuyToolUseCase,
  ProposeClaimToolUseCase,
  ProposeRebalanceToolUseCase,
  SetPolicyToolUseCase,
  PauseToolUseCase,
  UnsealPositionToolUseCase,
  CommitToolActionUseCase,
  // Wave 4 P7 — issuer-side tools
  ProposeDistributeYieldToolUseCase,
  ProposeKycAddToolUseCase,
  ProposeKycRemoveToolUseCase,
  ProposeUnpauseTokenToolUseCase,
  AuditQueryToolUseCase,
  // Wave 4 P11 — governance / protection / KYC tools
  CheckProtectionCoverageToolUseCase,
  ExplainKycAttestationToolUseCase,
  ProposeGovernanceVoteToolUseCase,
  CastEncryptedVoteToolUseCase,
  // Wave 4 §5 Path C — hosted-checkout via agent
  ProposeCreateCheckoutToolUseCase,
  // Q4 Part B (2026-05-15) — Telegram-link HavenBot tool
  LinkTelegramToolUseCase,
} from '../application/use-case/agent/tool/index.js';
import { CreateCheckoutSessionUseCase } from '../application/use-case/checkout/create-session.use-case.js';
import { CommitCreateCheckoutUseCase } from '../application/use-case/checkout/commit-create-checkout.use-case.js';
import { GetPolicyStateUseCase } from '../application/use-case/agent/policy/get-policy-state.use-case.js';
import { ConfirmTokenService } from '../application/use-case/agent/policy/confirm-token.service.js';
import { AppendAuditEventUseCase } from '../application/use-case/agent/policy/append-audit-event.use-case.js';
import { PauseAgentUseCase } from '../application/use-case/agent/policy/pause-agent.use-case.js';
import {
  PublishIssuerChannelEventUseCase,
  LoggingIssuerChannelTransport,
  HttpIssuerChannelTransport,
  type IIssuerChannelTransport,
} from '../application/use-case/agent/openclaw/publish-issuer-channel-event.use-case.js';
import {
  HttpBotIntentTransport,
  LoggingBotIntentTransport,
  MintAndDeliverOpenClawIntentUseCase,
  type IBotIntentTransport,
} from '../application/use-case/agent/openclaw/notify-intent-to-bot.use-case.js';
import { CreateOpenClawIntentUseCase } from '../application/use-case/agent/openclaw/create-intent.use-case.js';
import { IssueTelegramLinkCodeUseCase } from '../application/use-case/agent/openclaw/telegram-link.use-case.js';
import {
  classifyTier,
  DEFAULT_TIER_THRESHOLDS,
  type TierThresholds,
} from '../domain/agent/model/openclaw-intent.js';
import { OpenClawIntentEventsChannel } from './agent/openclaw-intent-events.channel.js';
import { GetPublicMetricsUseCase } from '../application/use-case/metrics/get-public-metrics.use-case.js';

interface Repositories {
  nonceRepo: INonceRepository;
  userRepo: IUserRepository;
  sessionRepo: ISessionRepository;
  escrowRepo: IEscrowRepository;
  withdrawalRepo: IWithdrawalRepository;
  escrowEventRepo: IEscrowEventRepository;
  yieldRecordRepo: IYieldRecordRepository;
}

interface MuHavenRepositories {
  portfolioRepo: IPortfolioRepository;
  rwaTokenRepo: IRwaTokenRepository;
  navHistoryRepo: INavHistoryRepository;
  taxEventRepo: ITaxEventRepository;
  issuerTokenDeployRepo: IIssuerTokenDeployRepository;
  oracleRepo: IOracleRepository;
}

interface AgentRepositories {
  agentStateRepo: IAgentStateRepository;
  agentAuditRepo: IAgentAuditRepository;
  agentCronStateRepo: IAgentCronStateRepository;
  agentConfirmTokenRepo: IAgentConfirmTokenRepository;
  agentDeviceCodeRepo: IAgentDeviceCodeRepository;
  openclawIntentRepo: IOpenClawIntentRepository;
  telegramLinkCodeRepo: ITelegramLinkCodeRepository;
  telegramLinkRepo: ITelegramLinkRepository;
}

interface CheckoutRepositories {
  checkoutSessionRepo: ICheckoutSessionRepository;
  webhookEndpointRepo: IWebhookEndpointRepository;
  webhookDeliveryRepo: IWebhookDeliveryRepository;
}

function createMemoryRepos(): Repositories {
  return {
    nonceRepo: new MemoryNonceRepository(),
    userRepo: new MemoryUserRepository(),
    sessionRepo: new MemorySessionRepository(),
    escrowRepo: new MemoryEscrowRepository(),
    withdrawalRepo: new MemoryWithdrawalRepository(),
    escrowEventRepo: new MemoryEscrowEventRepository(),
    yieldRecordRepo: new MemoryYieldRecordRepository(),
  };
}

function createPostgresRepos(): Repositories {
  const db = getDb();
  return {
    nonceRepo: new PgNonceRepository(db),
    userRepo: new PgUserRepository(db),
    sessionRepo: new PgSessionRepository(db),
    escrowRepo: new PgEscrowRepository(db),
    withdrawalRepo: new PgWithdrawalRepository(db),
    escrowEventRepo: new PgEscrowEventRepository(db),
    yieldRecordRepo: new PgYieldRecordRepository(db),
  };
}

function createMuHavenRepos(): MuHavenRepositories {
  const db = getDb();
  return {
    portfolioRepo: new PgPortfolioRepository(db),
    rwaTokenRepo: new PgRwaTokenRepository(db),
    navHistoryRepo: new PgNavHistoryRepository(db),
    taxEventRepo: new PgTaxEventRepository(db),
    issuerTokenDeployRepo: new PgIssuerTokenDeployRepository(db),
    oracleRepo: new PgOracleRepository(db),
  };
}

function createMemoryAgentRepos(): AgentRepositories {
  return {
    agentStateRepo: new MemoryAgentStateRepository(),
    agentAuditRepo: new MemoryAgentAuditRepository(),
    agentCronStateRepo: new MemoryAgentCronStateRepository(),
    agentConfirmTokenRepo: new MemoryAgentConfirmTokenRepository(),
    agentDeviceCodeRepo: new MemoryAgentDeviceCodeRepository(),
    openclawIntentRepo: new MemoryOpenClawIntentRepository(),
    telegramLinkCodeRepo: new MemoryTelegramLinkCodeRepository(),
    telegramLinkRepo: new MemoryTelegramLinkRepository(),
  };
}

function createPostgresAgentRepos(): AgentRepositories {
  const db = getDb();
  return {
    agentStateRepo: new PgAgentStateRepository(db),
    agentAuditRepo: new PgAgentAuditRepository(db),
    agentCronStateRepo: new PgAgentCronStateRepository(db),
    agentConfirmTokenRepo: new PgAgentConfirmTokenRepository(db),
    agentDeviceCodeRepo: new PgAgentDeviceCodeRepository(db),
    openclawIntentRepo: new PgOpenClawIntentRepository(db),
    telegramLinkCodeRepo: new PgTelegramLinkCodeRepository(db),
    telegramLinkRepo: new PgTelegramLinkRepository(db),
  };
}

function createMemoryCheckoutRepos(): CheckoutRepositories {
  return {
    checkoutSessionRepo: new MemoryCheckoutSessionRepository(),
    webhookEndpointRepo: new MemoryWebhookEndpointRepository(),
    webhookDeliveryRepo: new MemoryWebhookDeliveryRepository(),
  };
}

function createPostgresCheckoutRepos(): CheckoutRepositories {
  const db = getDb();
  return {
    checkoutSessionRepo: new PgCheckoutSessionRepository(db),
    webhookEndpointRepo: new PgWebhookEndpointRepository(db),
    webhookDeliveryRepo: new PgWebhookDeliveryRepository(db),
  };
}

let _repos: Repositories | null = null;
let _muhavenRepos: MuHavenRepositories | null = null;
let _agentRepos: AgentRepositories | null = null;
let _checkoutRepos: CheckoutRepositories | null = null;

function getRepos(): Repositories {
  if (!_repos) {
    const provider = getEnv().DB_PROVIDER;
    _repos = provider === 'postgres' ? createPostgresRepos() : createMemoryRepos();
  }
  return _repos;
}

function getMuHavenRepos(): MuHavenRepositories {
  if (!_muhavenRepos) {
    _muhavenRepos = createMuHavenRepos();
  }
  return _muhavenRepos;
}

function getAgentRepos(): AgentRepositories {
  if (!_agentRepos) {
    const provider = getEnv().DB_PROVIDER;
    _agentRepos = provider === 'postgres' ? createPostgresAgentRepos() : createMemoryAgentRepos();
  }
  return _agentRepos;
}

function getCheckoutRepos(): CheckoutRepositories {
  if (!_checkoutRepos) {
    const provider = getEnv().DB_PROVIDER;
    _checkoutRepos =
      provider === 'postgres'
        ? createPostgresCheckoutRepos()
        : createMemoryCheckoutRepos();
  }
  return _checkoutRepos;
}

const jwtService = new JwtService();
const siweVerifier = new SiweVerifier();
const fheService = new FheService();

const checkoutSseChannel = new SseChannelService();
let _webhookDispatcher: WebhookDispatcher | null = null;
function getWebhookDispatcher(): WebhookDispatcher {
  if (!_webhookDispatcher) {
    const repos = getCheckoutRepos();
    _webhookDispatcher = new WebhookDispatcher(
      repos.webhookEndpointRepo,
      repos.webhookDeliveryRepo,
    );
  }
  return _webhookDispatcher;
}

let _issuerLabelResolver: IIssuerLabelResolver | null = null;
function getIssuerLabelResolver(): IIssuerLabelResolver {
  if (!_issuerLabelResolver) {
    // Wave 4 prod hot-fix (2026-05-13): primary resolver reads
    // `user.issuerDisplayName` from the KYB user row so the buyer page
    // shows the company name captured at `/apply-issuer` step 1
    // (marked `verified: false` since it's issuer-supplied). Wave 5
    // adds an on-chain ONCHAINID resolver ahead of this in the chain
    // — that's the resolver that earns the verified chip. Stub +
    // empty-static stay as terminal fallbacks so non-approved /
    // missing-display-name addresses still surface the truncated
    // address rather than throwing.
    const repos = getRepos();
    _issuerLabelResolver = new ChainedIssuerLabelResolver(
      new KybIssuerLabelResolver(repos.userRepo),
      new ChainedIssuerLabelResolver(
        new StubIssuerLabelResolver(),
        new StaticIssuerLabelResolver({}),
      ),
    );
  }
  return _issuerLabelResolver;
}

function getQuickNodeVerifier(): QuickNodeVerifier | null {
  const secret = getEnv().QUICKNODE_WEBHOOK_SECRET;
  return secret ? new QuickNodeVerifier(secret) : null;
}

/**
 * Phase 9.A · Expansion (F2) — lazy singleton for the issuer-onboarding
 * deploy library. Returns null when the platform-deployer key + the
 * full set of platform addresses aren't configured (e.g. local dev with
 * just the apply endpoint exercised). The deploy endpoint surfaces a
 * 503 in that case.
 */
let _deployLibrary: DeployTokenLibrary | null = null;
let _deployLibraryAttempted = false;
function getDeployLibrary(): DeployTokenLibrary | null {
  if (_deployLibrary) return _deployLibrary;
  if (_deployLibraryAttempted) return null;
  _deployLibraryAttempted = true;

  const env = getEnv();
  const required = {
    RPC_URL: env.RPC_URL,
    PLATFORM_DEPLOYER_PRIVATE_KEY: env.PLATFORM_DEPLOYER_PRIVATE_KEY,
    SUBSCRIPTION_ADDRESS: env.SUBSCRIPTION_ADDRESS,
    TOKEN_REGISTRY_ADDRESS: env.TOKEN_REGISTRY_ADDRESS,
    INVESTOR_REGISTRY_V35_ADDRESS: env.INVESTOR_REGISTRY_V35_ADDRESS,
    YIELD_SNAPSHOT_ADDRESS: env.YIELD_SNAPSHOT_ADDRESS,
    IDENTITY_REGISTRY_ADDRESS: env.IDENTITY_REGISTRY_ADDRESS,
    MODULAR_COMPLIANCE_ADDRESS: env.MODULAR_COMPLIANCE_ADDRESS,
    STABLE_ADDRESS: env.STABLE_ADDRESS,
    ISSUER_ORACLE_ADDRESS: env.ISSUER_ORACLE_ADDRESS,
    KYC_ADAPTER_ADDRESS: env.KYC_ADAPTER_ADDRESS,
    // 2026-05-17 Design A · PREVENTION — required since the library now
    // registers `navWriter = platform.navWriter` (NOT `applicant`).
    PLATFORM_NAV_WRITER_ADDRESS: env.PLATFORM_NAV_WRITER_ADDRESS,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.warn(
      `[deploy-library] disabled — missing env: ${missing.join(', ')}`,
    );
    return null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.PLATFORM_DEPLOYER_PRIVATE_KEY!)) {
    console.warn(
      '[deploy-library] disabled — PLATFORM_DEPLOYER_PRIVATE_KEY is set but not a 0x-prefixed 32-byte hex',
    );
    return null;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.PLATFORM_NAV_WRITER_ADDRESS!)) {
    console.warn(
      '[deploy-library] disabled — PLATFORM_NAV_WRITER_ADDRESS is not a 0x-prefixed 20-byte hex',
    );
    return null;
  }
  // 2026-05-17 Design A · PREVENTION — refuse to construct if the
  // deployer-derived address doesn't match the registered navWriter.
  // Without this guard a token could deploy with `navWriter = <env>` while
  // the platform's signer is a DIFFERENT key, so the wizard-step-6
  // server-side setNAV would always 503 (no private key for that
  // navWriter). The IssuerOracleNavWriterService boot-asserts the same
  // invariant — checking here too means the deploy endpoint itself
  // refuses the misconfig instead of shipping a poisoned token.
  {
    const derived = privateKeyToAccount(
      env.PLATFORM_DEPLOYER_PRIVATE_KEY! as Hex,
    ).address.toLowerCase();
    const expected = env.PLATFORM_NAV_WRITER_ADDRESS!.toLowerCase();
    if (derived !== expected) {
      console.warn(
        `[deploy-library] disabled — PLATFORM_DEPLOYER_PRIVATE_KEY derives ${derived} ` +
          `but PLATFORM_NAV_WRITER_ADDRESS is ${expected}. The two must match so the ` +
          `server-side setNAV signer is the same EOA as the registered navWriter.`,
      );
      return null;
    }
  }

  _deployLibrary = new DeployTokenLibrary({
    rpcUrl: env.RPC_URL!,
    deployerPrivateKey: env.PLATFORM_DEPLOYER_PRIVATE_KEY! as Hex,
    platform: {
      subscription: env.SUBSCRIPTION_ADDRESS! as Address,
      tokenRegistry: env.TOKEN_REGISTRY_ADDRESS! as Address,
      investorRegistry: env.INVESTOR_REGISTRY_V35_ADDRESS! as Address,
      yieldSnapshot: env.YIELD_SNAPSHOT_ADDRESS! as Address,
      identityRegistry: env.IDENTITY_REGISTRY_ADDRESS! as Address,
      modularCompliance: env.MODULAR_COMPLIANCE_ADDRESS! as Address,
      stable: env.STABLE_ADDRESS! as Address,
      issuerOracle: env.ISSUER_ORACLE_ADDRESS! as Address,
      kycAdapter: env.KYC_ADAPTER_ADDRESS! as Address,
      navWriter: env.PLATFORM_NAV_WRITER_ADDRESS! as Address,
    },
    artifactsDir: resolveArtifactsDir(),
  });
  return _deployLibrary;
}

/**
 * 2026-05-17 Design A · PREVENTION — server-side NAV writer used by the
 * wizard step-6 unpause flow (`ProposeUnpauseTokenToolUseCase`). Lazy
 * singleton with the same null-when-unconfigured posture as the deploy
 * library; the use case surfaces 503 when this returns null.
 */
let _navWriterService: IIssuerOracleNavWriter | null = null;
let _navWriterAttempted = false;
function getNavWriterService(): IIssuerOracleNavWriter | null {
  if (_navWriterService) return _navWriterService;
  if (_navWriterAttempted) return null;
  _navWriterAttempted = true;

  const env = getEnv();
  if (
    !env.RPC_URL ||
    !env.PLATFORM_DEPLOYER_PRIVATE_KEY ||
    !env.PLATFORM_NAV_WRITER_ADDRESS ||
    !env.ISSUER_ORACLE_ADDRESS
  ) {
    console.warn(
      '[nav-writer-service] disabled — RPC_URL / PLATFORM_DEPLOYER_PRIVATE_KEY / PLATFORM_NAV_WRITER_ADDRESS / ISSUER_ORACLE_ADDRESS not all set',
    );
    return null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.PLATFORM_DEPLOYER_PRIVATE_KEY)) {
    console.warn(
      '[nav-writer-service] disabled — PLATFORM_DEPLOYER_PRIVATE_KEY is not a 0x-prefixed 32-byte hex',
    );
    return null;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.PLATFORM_NAV_WRITER_ADDRESS)) {
    console.warn(
      '[nav-writer-service] disabled — PLATFORM_NAV_WRITER_ADDRESS is not a 0x-prefixed 20-byte hex',
    );
    return null;
  }

  try {
    _navWriterService = new IssuerOracleNavWriterService({
      rpcUrl: env.RPC_URL,
      navWriterPrivateKey: env.PLATFORM_DEPLOYER_PRIVATE_KEY as Hex,
      expectedNavWriterAddress: env.PLATFORM_NAV_WRITER_ADDRESS as Address,
      issuerOracleAddress: env.ISSUER_ORACLE_ADDRESS as Address,
    });
  } catch (err) {
    console.warn(
      `[nav-writer-service] disabled — constructor threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  return _navWriterService;
}

// ── Wave 4 P2 — HavenBot tool surface singletons ─────────────────────
let _chatLlmService: IChatLlmService | null = null;
function getChatLlmService(): IChatLlmService {
  if (!_chatLlmService) _chatLlmService = new ChatLlmService();
  return _chatLlmService;
}

let _toolDispatcher: ToolDispatcher | null = null;
function getToolDispatcher(): ToolDispatcher {
  if (_toolDispatcher) return _toolDispatcher;

  const repos = getRepos();
  const muhaven = getMuHavenRepos();
  const agentRepos = getAgentRepos();

  const getPolicyState = new GetPolicyStateUseCase(agentRepos.agentStateRepo);
  // Share the singletons with `getCommitToolAction` + `getCommitCreateCheckout`
  // so all three commit paths use the same ConfirmTokenService /
  // AppendAuditEventUseCase instance (arch-review MEDIUM-3 consolidation).
  const confirmTokens = getConfirmTokenService();
  const appendAudit = getAppendAuditEvent();
  const pauseAgent = new PauseAgentUseCase(agentRepos.agentStateRepo, getPolicyState, appendAudit);

  _toolDispatcher = new ToolDispatcher({
    portfolioSummary: new PortfolioSummaryToolUseCase(
      muhaven.portfolioRepo,
      muhaven.rwaTokenRepo,
      muhaven.navHistoryRepo,
    ),
    quote: new QuoteToolUseCase(muhaven.rwaTokenRepo, muhaven.navHistoryRepo),
    proposeBuy: new ProposeBuyToolUseCase(
      muhaven.rwaTokenRepo,
      muhaven.navHistoryRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
      // Fresh-wallet gate — refuses propose_buy when the holder has
      // never had a Wrap / Unwrap / Transfer event for mhUSDC. Backend
      // can't read FHE balance directly; this catches the most common
      // new-user failure mode without a decrypt round-trip. Repo lives
      // on MuHavenRepositories (NOT Repositories — surfaced 2026-05-09
      // when the gate silently no-op'd on staging because
      // `repos.taxEventRepo` was undefined at runtime; TS's `null`
      // default on the use-case ctor swallowed the type error).
      muhaven.taxEventRepo,
      // Wave 4 P4 — fire-and-forget Telegram delivery when the user is
      // linked. Falls back to LoggingBotIntentTransport when
      // TELEGRAM_BOT_WORKER_URL / SERVICE_SECRET aren't wired, so the
      // call is always safe to invoke. Errors are swallowed inside the
      // use-case — dashboard ConfirmModal flow continues regardless.
      getMintAndDeliverIntent(),
    ),
    proposeClaim: new ProposeClaimToolUseCase(
      repos.yieldRecordRepo,
      repos.escrowRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
    ),
    proposeRebalance: new ProposeRebalanceToolUseCase(
      muhaven.rwaTokenRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
    ),
    setPolicy: new SetPolicyToolUseCase(getPolicyState, confirmTokens, appendAudit),
    pauseTool: new PauseToolUseCase(pauseAgent),
    unsealPosition: new UnsealPositionToolUseCase(),
    // ── Wave 4 P7 — issuer-side tools ──────────────────────────────
    proposeDistributeYield: new ProposeDistributeYieldToolUseCase(
      muhaven.rwaTokenRepo,
      repos.userRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
    ),
    proposeKycAdd: new ProposeKycAddToolUseCase(
      muhaven.rwaTokenRepo,
      repos.userRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
    ),
    proposeKycRemove: new ProposeKycRemoveToolUseCase(
      muhaven.rwaTokenRepo,
      repos.userRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
    ),
    proposeUnpauseToken: new ProposeUnpauseTokenToolUseCase(
      muhaven.rwaTokenRepo,
      repos.userRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
      getNavWriterService(),
    ),
    auditQuery: new AuditQueryToolUseCase(agentRepos.agentAuditRepo),
    // ── Wave 4 P11 — governance / protection / KYC tools ───────────────
    checkProtectionCoverage: new CheckProtectionCoverageToolUseCase({
      rpcUrl: getEnv().RPC_URL,
      defaultProtectionAddress: getEnv().DEFAULT_PROTECTION_ADDRESS,
      rwaTokenRepo: muhaven.rwaTokenRepo,
    }),
    explainKycAttestation: new ExplainKycAttestationToolUseCase({
      rpcUrl: getEnv().RPC_URL,
      kycAttestationRegistryAddress: getEnv().KYC_ATTESTATION_REGISTRY_ADDRESS,
    }),
    proposeGovernanceVote: new ProposeGovernanceVoteToolUseCase(
      muhaven.rwaTokenRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
      { encryptedGovernanceAddress: getEnv().ENCRYPTED_GOVERNANCE_ADDRESS },
    ),
    castEncryptedVote: new CastEncryptedVoteToolUseCase(
      getPolicyState,
      confirmTokens,
      appendAudit,
      { encryptedGovernanceAddress: getEnv().ENCRYPTED_GOVERNANCE_ADDRESS },
    ),
    // ── Wave 4 §5 Path C — hosted-checkout via agent ──────────────
    proposeCreateCheckout: new ProposeCreateCheckoutToolUseCase(
      muhaven.rwaTokenRepo,
      repos.userRepo,
      getPolicyState,
      confirmTokens,
      appendAudit,
    ),
    // ── Q4 Part B (2026-05-15) — Telegram-link HavenBot tool ───────
    linkTelegram: new LinkTelegramToolUseCase(
      new IssueTelegramLinkCodeUseCase(agentRepos.telegramLinkCodeRepo),
    ),
    resolveBotStartUrl: (linkCode: string): string | null => {
      const botUsername = getEnv().TELEGRAM_BOT_USERNAME;
      if (!botUsername) return null;
      return `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(linkCode)}`;
    },
  });
  return _toolDispatcher;
}

// ── Wave 4 P7 — issuer-channel broadcast (Telegram) ─────────────────
let _issuerChannelTransport: IIssuerChannelTransport | null = null;
function getIssuerChannelTransport(): IIssuerChannelTransport {
  if (_issuerChannelTransport) return _issuerChannelTransport;
  const env = getEnv();
  const workerUrl = env.TELEGRAM_BOT_WORKER_URL;
  const secret = env.TELEGRAM_BOT_SERVICE_SECRET;
  if (workerUrl && secret) {
    _issuerChannelTransport = new HttpIssuerChannelTransport({
      botWorkerUrl: workerUrl,
      serviceSecret: secret,
    });
  } else {
    // Operator setup deferred — fall back to the logging transport
    // so the use-case is callable in dev / staging / pre-BotFather
    // production.
    _issuerChannelTransport = new LoggingIssuerChannelTransport();
  }
  return _issuerChannelTransport;
}

let _publishIssuerChannelEvent: PublishIssuerChannelEventUseCase | null = null;
function getPublishIssuerChannelEvent(): PublishIssuerChannelEventUseCase {
  if (_publishIssuerChannelEvent) return _publishIssuerChannelEvent;
  _publishIssuerChannelEvent = new PublishIssuerChannelEventUseCase(
    getIssuerChannelTransport(),
  );
  return _publishIssuerChannelEvent;
}

// ── Wave 4 P4 — backend → telegram-bot intent push ──────────────────
//
// Mirrors the issuer-channel transport pattern: when the operator has
// wired both `TELEGRAM_BOT_WORKER_URL` AND `TELEGRAM_BOT_SERVICE_SECRET`,
// we POST to the bot worker's `/intent/notify`. Otherwise we fall back
// to a logging transport so the use-case is callable in dev / staging
// pre-BotFather. The propose-buy use-case treats the call as
// fire-and-forget — failures NEVER block the dashboard ConfirmModal flow.
let _botIntentTransport: IBotIntentTransport | null = null;
function getBotIntentTransport(): IBotIntentTransport {
  if (_botIntentTransport) return _botIntentTransport;
  const env = getEnv();
  const workerUrl = env.TELEGRAM_BOT_WORKER_URL;
  const secret = env.TELEGRAM_BOT_SERVICE_SECRET;
  if (workerUrl && secret) {
    _botIntentTransport = new HttpBotIntentTransport({
      botWorkerUrl: workerUrl,
      serviceSecret: secret,
    });
  } else {
    _botIntentTransport = new LoggingBotIntentTransport();
  }
  return _botIntentTransport;
}

// ── Wave 4 P4 — OpenClaw intent SSE channel singleton ──────────────
//
// In-process EventEmitter shape (see infra/agent/openclaw-intent-events.
// channel.ts NatSpec). Single-replica MVP — Wave 5 multi-replica deploys
// need Redis pub/sub. Container wires this once + injects into both
// confirm + deny use-cases AND exposes via `container.openClawIntent-
// EventsChannel` so the new SSE route handler can subscribe to it.
let _openClawIntentEventsChannel: OpenClawIntentEventsChannel | null = null;
function getOpenClawIntentEventsChannel(): OpenClawIntentEventsChannel {
  if (!_openClawIntentEventsChannel) {
    _openClawIntentEventsChannel = new OpenClawIntentEventsChannel();
  }
  return _openClawIntentEventsChannel;
}

function resolveTierThresholds(): TierThresholds {
  const env = getEnv();
  const inlineOverride = env.OPENCLAW_TIER_INLINE_MAX_USD6;
  const miniAppOverride = env.OPENCLAW_TIER_MINI_APP_MAX_USD6;
  if (!inlineOverride && !miniAppOverride) return DEFAULT_TIER_THRESHOLDS;
  // STAGING-ONLY override path. The env var only carries the staging
  // ceiling; the production cap is enforced inside `classifyTier` (it
  // throws if the override exceeds DEFAULT_TIER_THRESHOLDS). Fall back
  // to the default for any leg the operator didn't override — letting
  // the operator drop ONLY the inline ceiling without also re-stating
  // the mid-tier ceiling.
  const thresholds: TierThresholds = {
    inlineMaxUsd6: inlineOverride ? BigInt(inlineOverride) : DEFAULT_TIER_THRESHOLDS.inlineMaxUsd6,
    miniAppMaxUsd6: miniAppOverride
      ? BigInt(miniAppOverride)
      : DEFAULT_TIER_THRESHOLDS.miniAppMaxUsd6,
  };
  // Boot-time validation: trigger `classifyTier`'s ceiling + ordering
  // checks once HERE so a misconfigured staging fails LOUD on first
  // call to `getMintAndDeliverIntent()` (which lands at first
  // `/api/v1/agent/tools/propose-buy` request → backend logs a clear
  // error vs. a silent 500 deep inside the propose flow). Pass `0n` —
  // amount-side checks pass for any valid threshold combination, so
  // this isolates threshold-validation from amount-classification.
  classifyTier(0n, thresholds);
  return thresholds;
}

let _mintAndDeliverIntent: MintAndDeliverOpenClawIntentUseCase | null = null;
function getMintAndDeliverIntent(): MintAndDeliverOpenClawIntentUseCase {
  if (_mintAndDeliverIntent) return _mintAndDeliverIntent;
  const agentRepos = getAgentRepos();
  _mintAndDeliverIntent = new MintAndDeliverOpenClawIntentUseCase(
    new CreateOpenClawIntentUseCase(agentRepos.openclawIntentRepo, resolveTierThresholds()),
    agentRepos.telegramLinkRepo,
    getBotIntentTransport(),
  );
  return _mintAndDeliverIntent;
}

// ── Wave 4 P9 — public metrics aggregator ──────────────────────────
let _publicMetricsUseCase: GetPublicMetricsUseCase | null = null;
function getPublicMetricsUseCase(): GetPublicMetricsUseCase {
  if (_publicMetricsUseCase) return _publicMetricsUseCase;
  const muhaven = getMuHavenRepos();
  _publicMetricsUseCase = new GetPublicMetricsUseCase(
    muhaven.taxEventRepo,
    muhaven.navHistoryRepo,
    muhaven.rwaTokenRepo,
  );
  return _publicMetricsUseCase;
}

// ── Wave 4 §5 Path C — hosted-checkout via agent ──────────────────────
//
// Two use-cases share a single `CreateCheckoutSessionUseCase` instance so
// the dashboard CheckoutLinkModal path AND the HavenBot agent path resolve
// the same env-configured baseUrl. The session id + fragment key live on
// the use-case's instance state (none, today — it's stateless), but
// sharing reads from a single env var keeps a future env-override
// consistent across both.
let _createCheckoutSession: CreateCheckoutSessionUseCase | null = null;
function getCreateCheckoutSession(): CreateCheckoutSessionUseCase {
  if (_createCheckoutSession) return _createCheckoutSession;
  _createCheckoutSession = new CreateCheckoutSessionUseCase(
    getCheckoutRepos().checkoutSessionRepo,
    getEnv().CHECKOUT_PUBLIC_URL,
    getRepos().userRepo,
  );
  return _createCheckoutSession;
}

// Shared singletons across both commit paths — arch-review MEDIUM-3 fix.
// Before consolidation, `getCommitCreateCheckout` AND `getCommitToolAction`
// each instantiated their own `ConfirmTokenService` + `AppendAuditEventUseCase`.
// Both services are stateless TODAY (the constructor only stores a repo
// reference), so the duplication was harmless. The risk was forward —
// if `ConfirmTokenService` ever gains an in-process cache (nonce dedupe,
// request coalescing), the two commit paths would silently bifurcate.
// Consolidate via a single getter pair so future state lives on a shared
// instance.
let _confirmTokenService: ConfirmTokenService | null = null;
function getConfirmTokenService(): ConfirmTokenService {
  if (_confirmTokenService) return _confirmTokenService;
  _confirmTokenService = new ConfirmTokenService(getAgentRepos().agentConfirmTokenRepo);
  return _confirmTokenService;
}

let _appendAuditEvent: AppendAuditEventUseCase | null = null;
function getAppendAuditEvent(): AppendAuditEventUseCase {
  if (_appendAuditEvent) return _appendAuditEvent;
  _appendAuditEvent = new AppendAuditEventUseCase(getAgentRepos().agentAuditRepo);
  return _appendAuditEvent;
}

let _commitCreateCheckout: CommitCreateCheckoutUseCase | null = null;
function getCommitCreateCheckout(): CommitCreateCheckoutUseCase {
  if (_commitCreateCheckout) return _commitCreateCheckout;
  _commitCreateCheckout = new CommitCreateCheckoutUseCase(
    getConfirmTokenService(),
    getAppendAuditEvent(),
    getMuHavenRepos().rwaTokenRepo,
    getCreateCheckoutSession(),
    getIssuerLabelResolver(),
    // Third-pass review (Code-Reviewer HIGH-1): wire the agent-state
    // repo so commit_create_checkout bumps confirmedActionCount (the
    // Confirm-per-action → PolicyBound autonomy gate). Same singleton
    // wired into commit-tool-action — see comment block above.
    getAgentRepos().agentStateRepo,
  );
  return _commitCreateCheckout;
}

let _commitToolAction: CommitToolActionUseCase | null = null;
function getCommitToolAction(): CommitToolActionUseCase {
  if (_commitToolAction) return _commitToolAction;
  _commitToolAction = new CommitToolActionUseCase(
    getConfirmTokenService(),
    getAppendAuditEvent(),
    getAgentRepos().agentStateRepo,
  );
  return _commitToolAction;
}

export const container = {
  get nonceRepo() {
    return getRepos().nonceRepo;
  },
  get userRepo() {
    return getRepos().userRepo;
  },
  get sessionRepo() {
    return getRepos().sessionRepo;
  },
  get escrowRepo() {
    return getRepos().escrowRepo;
  },
  get withdrawalRepo() {
    return getRepos().withdrawalRepo;
  },
  get escrowEventRepo() {
    return getRepos().escrowEventRepo;
  },
  get portfolioRepo() {
    return getMuHavenRepos().portfolioRepo;
  },
  get yieldRecordRepo() {
    return getRepos().yieldRecordRepo;
  },
  get rwaTokenRepo() {
    return getMuHavenRepos().rwaTokenRepo;
  },
  get navHistoryRepo() {
    return getMuHavenRepos().navHistoryRepo;
  },
  get taxEventRepo() {
    return getMuHavenRepos().taxEventRepo;
  },
  get issuerTokenDeployRepo() {
    return getMuHavenRepos().issuerTokenDeployRepo;
  },
  get oracleRepo() {
    return getMuHavenRepos().oracleRepo;
  },
  get agentStateRepo() {
    return getAgentRepos().agentStateRepo;
  },
  get agentAuditRepo() {
    return getAgentRepos().agentAuditRepo;
  },
  get agentCronStateRepo() {
    return getAgentRepos().agentCronStateRepo;
  },
  get agentConfirmTokenRepo() {
    return getAgentRepos().agentConfirmTokenRepo;
  },
  get agentDeviceCodeRepo() {
    return getAgentRepos().agentDeviceCodeRepo;
  },
  get openclawIntentRepo() {
    return getAgentRepos().openclawIntentRepo;
  },
  get telegramLinkCodeRepo() {
    return getAgentRepos().telegramLinkCodeRepo;
  },
  get telegramLinkRepo() {
    return getAgentRepos().telegramLinkRepo;
  },
  get checkoutSessionRepo() {
    return getCheckoutRepos().checkoutSessionRepo;
  },
  get webhookEndpointRepo() {
    return getCheckoutRepos().webhookEndpointRepo;
  },
  get webhookDeliveryRepo() {
    return getCheckoutRepos().webhookDeliveryRepo;
  },
  get checkoutSseChannel() {
    return checkoutSseChannel;
  },
  get openClawIntentEventsChannel() {
    return getOpenClawIntentEventsChannel();
  },
  get webhookDispatcher() {
    return getWebhookDispatcher();
  },
  get issuerLabelResolver() {
    return getIssuerLabelResolver();
  },
  get nonceService() {
    return new NonceService(getRepos().nonceRepo);
  },
  jwtService,
  siweVerifier,
  fheService,
  getQuickNodeVerifier,
  getDeployLibrary,
  // Wave 4 P2 — HavenBot tool surface
  get chatLlmService() {
    return getChatLlmService();
  },
  get toolDispatcher() {
    return getToolDispatcher();
  },
  get commitToolAction() {
    return getCommitToolAction();
  },
  // Wave 4 §5 Path C — hosted-checkout via agent
  get createCheckoutSession() {
    return getCreateCheckoutSession();
  },
  get commitCreateCheckout() {
    return getCommitCreateCheckout();
  },
  // Wave 4 P7 — issuer-channel broadcast use-case
  get publishIssuerChannelEvent() {
    return getPublishIssuerChannelEvent();
  },
  // Wave 4 P9 — public metrics aggregator (singleton owns the
  // 60s in-process cache; reusing the route's instance is what
  // makes the cache TTL meaningful).
  get publicMetricsUseCase() {
    return getPublicMetricsUseCase();
  },
};
