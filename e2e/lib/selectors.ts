import type { Page } from '@playwright/test'

/**
 * Single source of truth for data-testid values. Paired with the contract in
 * development/DEV_WAVE_3/qa/PLAYWRIGHT_QA.md §4 — renaming anything here must
 * be matched by a frontend edit in the same PR.
 */
export const SEL = {
  // auth
  authModeToggle: 'auth-mode-toggle',
  authCta: 'auth-cta',
  authRoleInvestor: 'auth-role-investor',
  authRoleIssuer: 'auth-role-issuer',
  authPasskeyNameInput: 'auth-passkey-name-input',
  authDemoWhitelistCta: 'auth-demo-whitelist-cta',
  authDemoSkip: 'auth-demo-skip',

  // nav
  navWalletPill: 'nav-wallet-pill',
  navWalletLogout: 'nav-wallet-logout',
  navWalletSignin: 'nav-wallet-signin',
  navRoleInvestor: 'nav-role-investor',
  navRoleIssuer: 'nav-role-issuer',
  navDarkToggle: 'nav-dark-toggle',
  sessionStatus: 'session-status',

  // deposit
  depositPathEncrypted: 'deposit-path-encrypted',
  depositPathWrap: 'deposit-path-wrap',
  depositTokenSelect: 'deposit-token-select',
  depositAmountInput: 'deposit-amount-input',
  depositCta: 'deposit-cta',
  depositSuccessCard: 'deposit-success-card',
  depositErrorCard: 'deposit-error-card',
  depositQuick100: 'deposit-quick-100',
  depositQuick1000: 'deposit-quick-1000',
  depositQuick5000: 'deposit-quick-5000',

  // distribute
  distributeTokenSelect: 'distribute-token-select',
  distributeAmountInput: 'distribute-amount-input',
  distributeCta: 'distribute-cta',
  distributeRevealConfidential: 'distribute-reveal-confidential',
  distributeRefreshPusdc: 'distribute-refresh-pusdc',
  distributeReceipt: 'distribute-receipt',
  distributeError: 'distribute-error',
  distributeReceiptId: 'distribute-receipt-id',

  // marketplace
  marketplaceSearch: 'marketplace-search',
  marketplaceFilterAll: 'marketplace-filter-all',
  marketplaceTokenCard: 'marketplace-token-card',
  marketplaceTokenName: 'marketplace-token-name',
  marketplaceTokenSymbol: 'marketplace-token-symbol',
  marketplaceInvestCta: 'marketplace-invest-cta',

  // portfolio
  portfolioHoldingCard: 'portfolio-holding-card',
  portfolioRevealAllCta: 'portfolio-reveal-all-cta',
  portfolioDecryptCta: 'portfolio-decrypt-cta',
  portfolioPusdcDecryptCta: 'portfolio-pusdc-decrypt-cta',
  portfolioPusdcRefresh: 'portfolio-pusdc-refresh',

  // yields (Wave 3 legacy)
  yieldsClaimRow: 'yields-claim-row',
  yieldsClaimCta: 'yields-claim-cta',
  legacyClaimCta: 'legacy-claim-cta',

  // yields (Wave 3.5 epoch-based pull)
  epochRow: 'epoch-row',
  epochClaimCta: 'epoch-claim-cta',

  // trade — buy/sell mode toggle (Wave 3.5 Phase 6.5)
  tradeModeToggle: 'trade-mode-toggle',
  tradeModeBuy: 'trade-mode-buy',
  tradeModeSell: 'trade-mode-sell',

  // buy mode (Wave 3.5)
  buyTokenSelect: 'buy-token-select',
  buyAmountInput: 'buy-amount-input',
  buyCta: 'buy-cta',
  buySuccessCard: 'buy-success-card',
  buyErrorCard: 'buy-error-card',
  buyKycBlocked: 'buy-kyc-blocked',
  buyNavReadout: 'buy-nav-readout',

  // sell mode (Wave 3.5 Phase 6.5)
  sellTokenSelect: 'sell-token-select',
  sellAmountInput: 'sell-amount-input',
  sellNavReadout: 'sell-nav-readout',
  sellHoldingCard: 'sell-holding-card',
  sellHoldingReadout: 'sell-holding-readout',
  sellRevealBalance: 'sell-reveal-balance',
  sellInstantCap: 'sell-instant-cap',
  sellFillHalf: 'sell-fill-half',
  sellFillMax: 'sell-fill-max',
  sellEscalateWarning: 'sell-escalate-warning',
  sellExceedsHolding: 'sell-exceeds-holding',
  redeemCta: 'redeem-cta',
  redeemInstantSuccessCard: 'redeem-instant-success-card',
  redeemQueuedSuccessCard: 'redeem-queued-success-card',
  redeemErrorCard: 'redeem-error-card',
  redeemKycBlocked: 'redeem-kyc-blocked',

  // transfer (Wave 3.5 P2P)
  transferTokenSelect: 'transfer-token-select',
  transferRecipientInput: 'transfer-recipient-input',
  transferSimReadout: 'transfer-sim-readout',
  transferAmountInput: 'transfer-amount-input',
  transferCta: 'transfer-cta',
  transferSuccessCard: 'transfer-success-card',
  transferErrorCard: 'transfer-error-card',

  // redemptions (Wave 3.5 queued)
  redemptionsRefresh: 'redemptions-refresh',
  redemptionRow: 'redemption-row',
  redemptionDecryptProceeds: 'redemption-decrypt-proceeds',
  redemptionClaimCta: 'redemption-claim-cta',

  // activity
  activityFilterAll: 'activity-filter-all',
  activityFilterYield: 'activity-filter-yield',
  activityFilterEscrow: 'activity-filter-escrow',
  activityLoadMore: 'activity-load-more',
} as const

/** Shorthand: `byTestId(page, SEL.authCta)` → `page.getByTestId('auth-cta')`. */
export function byTestId(page: Page, testid: string) {
  return page.getByTestId(testid)
}
