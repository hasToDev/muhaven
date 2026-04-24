/**
 * IPriceOracle + IIssuerControlledOracle consolidated ABI.
 *
 * The SDK's `OracleClient` reads against any `IPriceOracle` impl and writes
 * against `IIssuerControlledOracle` (NAV publication + accept/reject pending).
 * `ChainlinkFunctionsOracle` exposes a `requestNAV(token)` write path that
 * backend cron uses — kept here on the same ABI so one client covers both.
 */
export const priceOracleAbi = [
  // ── Reads (IPriceOracle) ─────────────────────────────────────────────
  {
    name: 'getNAV',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'nav', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
    ],
  },
  {
    name: 'getMaxStaleness',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'isFresh',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  // ── Writes (IIssuerControlledOracle) ─────────────────────────────────
  {
    name: 'setNAV',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'newNAV', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'acceptPendingNAV',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
  {
    name: 'rejectPendingNAV',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
  // ── Views (IIssuerControlledOracle) ──────────────────────────────────
  {
    name: 'getPendingNAV',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'pendingNAV', type: 'uint256' },
      { name: 'pendingUpdatedAt', type: 'uint256' },
    ],
  },
  {
    name: 'getMaxDeviationBps',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'getNavWriter',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'isSequencerUp',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  // ── ChainlinkFunctionsOracle extension ───────────────────────────────
  {
    name: 'requestNAV',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  // ── Events ────────────────────────────────────────────────────────────
  {
    name: 'NAVUpdated',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'nav', type: 'uint256', indexed: false },
      { name: 'updatedAt', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'NAVPending',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'pendingNAV', type: 'uint256', indexed: false },
      { name: 'pendingUpdatedAt', type: 'uint256', indexed: false },
      { name: 'deviationBps', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
] as const
