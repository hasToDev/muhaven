import {
  MemoryNonceRepository,
  MemoryUserRepository,
  MemorySessionRepository,
  MemoryEscrowRepository,
  MemoryWithdrawalRepository,
  MemoryEscrowEventRepository,
  MemoryYieldRecordRepository,
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
} from './repository/postgres/index.js';
import { getDb } from './repository/postgres/db.js';
import { JwtService } from './auth/jwt.service.js';
import { NonceService } from './auth/nonce.service.js';
import { SiweVerifier } from './auth/siwe-verifier.js';
import { FheService } from './fhe/fhe.service.js';
import { QuickNodeVerifier } from './webhook/quicknode-verifier.js';
import { getEnv } from '../core/config.js';
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
  };
}

let _repos: Repositories | null = null;
let _muhavenRepos: MuHavenRepositories | null = null;

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

const jwtService = new JwtService();
const siweVerifier = new SiweVerifier();
const fheService = new FheService();

function getQuickNodeVerifier(): QuickNodeVerifier | null {
  const secret = getEnv().QUICKNODE_WEBHOOK_SECRET;
  return secret ? new QuickNodeVerifier(secret) : null;
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
  get nonceService() {
    return new NonceService(getRepos().nonceRepo);
  },
  jwtService,
  siweVerifier,
  fheService,
  getQuickNodeVerifier,
};
