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
import { getEnv } from '../core/config.js';
import type { Address, Hex } from 'viem';
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
  StaticIssuerLabelResolver,
  StubIssuerLabelResolver,
  type IIssuerLabelResolver,
} from './checkout/issuer-label-resolver.js';

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
    // Wave 4: stub primary, optional static fallback. Wave 5 swaps the
    // primary for an on-chain ONCHAINID resolver.
    _issuerLabelResolver = new ChainedIssuerLabelResolver(
      new StubIssuerLabelResolver(),
      new StaticIssuerLabelResolver({}),
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
    },
    artifactsDir: resolveArtifactsDir(),
  });
  return _deployLibrary;
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
};
