// ── Mock Data ──
// COLORS object removed — all styling now via Tailwind CSS theme tokens

// ── Landing Page Data ──

export const LANDING_STATS = [
  { label: 'Smart Contracts', value: 7, prefix: '', suffix: '' },
  { label: 'Balance Privacy', value: 100, prefix: '', suffix: '%' },
  { label: 'AI Agents', value: 2, prefix: '', suffix: '' },
  { label: 'Balances Exposed', value: 0, prefix: '', suffix: '' },
]

export const LANDING_FEATURES = [
  {
    title: 'Encrypted Balances',
    description: 'Every token balance is stored as an FHE-encrypted euint128. Only the owner can decrypt via EIP-712 permit.',
    icon: 'Shield',
    code: 'FHE.asEuint128(amount)',
  },
  {
    title: 'Private Yield Distribution',
    description: 'Yield is calculated and distributed using FHE math. Issuers see aggregates, never individual positions.',
    icon: 'TrendingUp',
    code: 'FHE.div(totalYield, investorCount)',
  },
  {
    title: 'AI Portfolio Agent',
    description: 'An AI agent manages your portfolio using function calls on encrypted state. It never sees your balances.',
    icon: 'Sparkles',
    code: 'agent.execute(encryptedState)',
  },
]

export const LANDING_FAQ = [
  {
    title: 'Is my balance really private?',
    content: 'Yes. Balances are stored as FHE-encrypted euint128 values on-chain. Only you can decrypt them using an EIP-712 permit signed by your wallet. Not even the smart contract owner, the AI agent, or Fhenix validators can see your balance.',
  },
  {
    title: 'How does the AI agent work with encrypted data?',
    content: 'The agent uses function calling to interact with smart contracts that operate on encrypted state. It can trigger deposits, rebalances, and yield claims without ever decrypting the underlying values. The FHE.select() pattern ensures the same gas cost whether an operation succeeds or fails.',
  },
  {
    title: 'What tokens are supported?',
    content: 'MuHaven supports any ERC-20 RWA token wrapped into fhERC-20 format via MuHavenVault, plus native issuance. Current demo tokens include Treasury Bond Fund (MHTB) and Money Market Fund (MHMM).',
  },
  {
    title: 'Can issuers see individual investor balances?',
    content: 'No. Issuers can only see aggregate metrics: total supply (if they enable public total supply), number of investors, and total yield distributed. Individual balances remain encrypted.',
  },
  {
    title: 'What happens if the AI agent makes a bad trade?',
    content: 'Risk guardrails are stored as encrypted parameters (euint64) on-chain — max drawdown, min yield threshold, drift tolerance, and max daily spend. The agent cannot exceed these bounds, and the FHE.select() pattern silently nullifies any operation that violates them.',
  },
]

export const LANDING_CODE_LINES = [
  { text: '// MuHavenToken.sol — encrypted transfer', color: 'cool' as const },
  { text: 'function transfer(address to, InEuint128 calldata encAmount)', color: 'compute' as const },
  { text: '  external onlyEligible(msg.sender) onlyEligible(to) {', color: 'white' as const },
  { text: '  euint128 amount = FHE.asEuint128(encAmount);', color: 'signal' as const },
  { text: '  ebool hasEnough = FHE.gte(balances[msg.sender], amount);', color: 'signal' as const },
  { text: '  euint128 transferAmt = FHE.select(hasEnough, amount, zero);', color: 'gold' as const },
  { text: '  balances[msg.sender] = FHE.sub(balances[msg.sender], transferAmt);', color: 'white' as const },
  { text: '  balances[to] = FHE.add(balances[to], transferAmt);', color: 'white' as const },
  { text: '  FHE.allow(balances[to], to);  // permit-based decrypt', color: 'cipher' as const },
  { text: '}', color: 'white' as const },
]

// ── Portfolio / Dashboard Data ──

export const PORTFOLIO = {
  totalValue: 51247.83,
  change: 2.3,
  holdings: [
    { name: 'Treasury Bond Fund', symbol: 'MHTB', value: 35873.48, pct: 70, apy: 4.8, colorClass: 'bg-compute' },
    { name: 'Money Market Fund', symbol: 'MHMM', value: 10249.57, pct: 20, apy: 5.2, colorClass: 'bg-midnight dark:bg-signal' },
    { name: 'Cash Buffer', symbol: 'USDC', value: 5124.78, pct: 10, apy: 5.0, colorClass: 'bg-cipher' },
  ],
  activity: [
    { type: 'yield', desc: 'Yield claimed', amount: '$201.34', token: 'Treasury Fund', time: '2h ago' },
    { type: 'rebalance', desc: 'Rebalanced', amount: '+$500 Treasury', token: '−$500 Cash', time: '1d ago' },
    { type: 'yield', desc: 'Yield claimed', amount: '$43.72', token: 'Money Market', time: '3d ago' },
    { type: 'deposit', desc: 'Deposited', amount: '$5,000.00', token: 'via PUSDC', time: '1w ago' },
    { type: 'yield', desc: 'Yield claimed', amount: '$147.20', token: 'Treasury Fund', time: '2w ago' },
    { type: 'yield', desc: 'Yield claimed', amount: '$41.80', token: 'Money Market', time: '2w ago' },
    { type: 'rebalance', desc: 'Rebalanced', amount: '+$1,000 Treasury', token: '−$1,000 Cash', time: '3w ago' },
    { type: 'deposit', desc: 'Deposited', amount: '$10,000.00', token: 'via PUSDC', time: '1mo ago' },
    { type: 'yield', desc: 'Yield claimed', amount: '$145.50', token: 'Treasury Fund', time: '1mo ago' },
    { type: 'deposit', desc: 'Deposited', amount: '$36,247.83', token: 'Initial deposit', time: '2mo ago' },
  ],
}

export const ISSUER_TOKENS = [
  { name: 'MuHaven Treasury Bond Fund', symbol: 'MHTB', supply: '1,250,000', investors: 47, apy: 4.8, schedule: 'Monthly' },
  { name: 'MuHaven Money Market', symbol: 'MHMM', supply: '680,000', investors: 31, apy: 5.2, schedule: 'Monthly' },
]

export const YIELDS_DATA = {
  totalEarned: 1247.83,
  pending: 201.34,
  nextPayout: '~3 days',
  pendingClaims: [
    { token: 'Treasury Bond Fund', amount: 156.20 },
    { token: 'Money Market Fund', amount: 45.14 },
  ],
  history: [
    { date: 'Mar 15', token: 'Treasury Fund', amount: '$148.90', status: 'claimed' },
    { date: 'Mar 15', token: 'Money Market', amount: '$42.30', status: 'claimed' },
    { date: 'Feb 15', token: 'Treasury Fund', amount: '$147.20', status: 'claimed' },
    { date: 'Feb 15', token: 'Money Market', amount: '$41.80', status: 'claimed' },
    { date: 'Jan 15', token: 'Treasury Fund', amount: '$145.50', status: 'claimed' },
  ],
}

// ── Chart Data ──

export const TOKEN_GROWTH_DATA: Record<string, { labels: string[]; values: number[] }> = {
  MHTB: { labels: ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'], values: [28, 31, 35, 39, 43, 47] },
  MHMM: { labels: ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'], values: [15, 18, 21, 24, 28, 31] },
}

// ── Investors Mock Data (Preview) ──

export const INVESTORS_DATA = [
  { address: '0x7a3f...b29e', alias: 'Investor #1', kycStatus: 'verified' as const, jurisdiction: 'US', tokens: ['MHTB', 'MHMM'], joinDate: 'Jan 2025', lastActivity: '2h ago' },
  { address: '0x9c2d...f1a3', alias: 'Investor #2', kycStatus: 'verified' as const, jurisdiction: 'EU', tokens: ['MHTB'], joinDate: 'Jan 2025', lastActivity: '1d ago' },
  { address: '0x4b8e...c7d2', alias: 'Investor #3', kycStatus: 'pending' as const, jurisdiction: 'UK', tokens: ['MHMM'], joinDate: 'Feb 2025', lastActivity: '3d ago' },
  { address: '0xe1f5...a9b8', alias: 'Investor #4', kycStatus: 'verified' as const, jurisdiction: 'SG', tokens: ['MHTB', 'MHMM'], joinDate: 'Feb 2025', lastActivity: '5h ago' },
  { address: '0x2d3a...e6c1', alias: 'Investor #5', kycStatus: 'expired' as const, jurisdiction: 'US', tokens: ['MHTB'], joinDate: 'Dec 2024', lastActivity: '2w ago' },
  { address: '0x8f7b...d4a5', alias: 'Investor #6', kycStatus: 'verified' as const, jurisdiction: 'EU', tokens: ['MHTB', 'MHMM'], joinDate: 'Mar 2025', lastActivity: '12h ago' },
  { address: '0x5c9e...b3f7', alias: 'Investor #7', kycStatus: 'verified' as const, jurisdiction: 'US', tokens: ['MHMM'], joinDate: 'Mar 2025', lastActivity: '1d ago' },
  { address: '0xa2d4...c8e6', alias: 'Investor #8', kycStatus: 'rejected' as const, jurisdiction: 'CN', tokens: [], joinDate: 'Mar 2025', lastActivity: '1w ago' },
  { address: '0x3e1f...a7b9', alias: 'Investor #9', kycStatus: 'pending' as const, jurisdiction: 'UK', tokens: ['MHTB'], joinDate: 'Mar 2025', lastActivity: '4h ago' },
  { address: '0xd6c8...f2a4', alias: 'Investor #10', kycStatus: 'verified' as const, jurisdiction: 'SG', tokens: ['MHTB'], joinDate: 'Jan 2025', lastActivity: '6h ago' },
]

// ── Compliance Mock Data (Preview) ──

export const COMPLIANCE_DATA = {
  kycGateConfig: {
    provider: 'ERC-3643 ONCHAINID',
    requiredLevel: 'Full KYC',
    autoReject: true,
    gracePeriodDays: 30,
  },
  jurisdictions: [
    { code: 'US', name: 'United States', flag: '\u{1F1FA}\u{1F1F8}', status: 'active' as const, investors: 23 },
    { code: 'EU', name: 'European Union', flag: '\u{1F1EA}\u{1F1FA}', status: 'active' as const, investors: 15 },
    { code: 'UK', name: 'United Kingdom', flag: '\u{1F1EC}\u{1F1E7}', status: 'active' as const, investors: 6 },
    { code: 'SG', name: 'Singapore', flag: '\u{1F1F8}\u{1F1EC}', status: 'review' as const, investors: 3 },
    { code: 'CN', name: 'China', flag: '\u{1F1E8}\u{1F1F3}', status: 'blocked' as const, investors: 0 },
  ],
  trustedIssuers: [
    { name: 'MuHaven Identity Service', address: '0xab12...cd34', claims: 78, status: 'active' as const },
    { name: 'Reineira KYC Oracle', address: '0xef56...gh78', claims: 45, status: 'active' as const },
  ],
  stats: {
    totalVerified: 47,
    pendingReview: 5,
    expiringSoon: 3,
    blocked: 2,
  },
}

// ── Extended Data for Redesigned Pages ──

export const YIELD_BREAKDOWN: Record<string, number> = {
  MHTB: 873.48,
  MHMM: 374.35,
}

export const TOKEN_OVERVIEW = {
  totalAUM: 1_930_000,
  totalInvestors: 78,
  weightedAPY: 4.96,
  activeTokens: 2,
}

export const DISTRIBUTION_HISTORY = [
  { date: 'Mar 15', token: 'MHTB', totalAmount: 50_000, investors: 47, status: 'completed' as const },
  { date: 'Feb 15', token: 'MHTB', totalAmount: 48_500, investors: 44, status: 'completed' as const },
  { date: 'Mar 15', token: 'MHMM', totalAmount: 29_400, investors: 31, status: 'completed' as const },
  { date: 'Feb 15', token: 'MHMM', totalAmount: 27_800, investors: 29, status: 'completed' as const },
]
