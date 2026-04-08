export const COLORS = {
  bgPrimary: '#FAFAF8',
  bgSecondary: '#F3F2EE',
  bgTertiary: '#ECEAE4',
  surface: '#FFFFFF',
  border: '#E2E0DA',
  borderSubtle: '#EDEBE6',
  textPrimary: '#1A1A18',
  textSecondary: '#6B6960',
  textTertiary: '#9C9889',
  teal: '#1A9E74',
  tealLight: '#E8F5EF',
  tealDark: '#157A5A',
  coral: '#D4603A',
  coralLight: '#FDF0EB',
  amber: '#D4940A',
  amberLight: '#FEF7E6',
  positive: '#1A9E74',
  negative: '#D44A3A',
}

export const INITIAL_MESSAGES = [
  {
    id: 1,
    role: 'agent' as const,
    text: 'Welcome back. Your portfolio is up 2.3% this month. Your treasury yields were claimed automatically yesterday. How can I help?',
  },
]

export const PORTFOLIO = {
  totalValue: 51247.83,
  change: 2.3,
  holdings: [
    { name: 'Treasury Bond Fund', symbol: 'MHTB', value: 35873.48, pct: 70, apy: 4.8, color: COLORS.teal },
    { name: 'Money Market Fund', symbol: 'MHMM', value: 10249.57, pct: 20, apy: 5.2, color: '#6366F1' },
    { name: 'Cash Buffer', symbol: 'USDC', value: 5124.78, pct: 10, apy: 5.0, color: COLORS.amber },
  ],
  activity: [
    { type: 'yield', desc: 'Yield claimed', amount: '$201.34', token: 'Treasury Fund', time: '2h ago' },
    { type: 'rebalance', desc: 'Rebalanced', amount: '+$500 Treasury', token: '−$500 Cash', time: '1d ago' },
    { type: 'yield', desc: 'Yield claimed', amount: '$43.72', token: 'Money Market', time: '3d ago' },
    { type: 'deposit', desc: 'Deposited', amount: '$5,000.00', token: 'via PUSDC', time: '1w ago' },
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
