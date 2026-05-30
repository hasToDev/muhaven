import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the write/read dispatch layer so the test asserts what calldata the
// service hands the kernel sender, without touching viem / ZeroDev.
vi.mock('../provider', () => ({
  contractWrite: vi.fn().mockResolvedValue('0xtxhash'),
  contractRead: vi.fn(),
}))

import * as Erc20Service from '../Erc20Service'
import { contractWrite } from '../provider'
import { erc20Abi } from '@/contracts/abis'

const USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as `0x${string}`
const TO = '0x1111111111111111111111111111111111111111' as `0x${string}`

describe('Erc20Service.transfer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches transfer(to, amount) via the kernel sender and returns the tx hash', async () => {
    const amount = 2_500_000n // 2.5 USDC in base-6 units
    const hash = await Erc20Service.transfer(USDC, TO, amount)

    expect(hash).toBe('0xtxhash')
    expect(contractWrite).toHaveBeenCalledTimes(1)
    expect(contractWrite).toHaveBeenCalledWith(
      USDC,
      erc20Abi,
      'transfer',
      [TO, amount],
      'ERC20',
    )
  })

  it('passes the exact bigint amount through (no precision coercion)', async () => {
    // 1.234567 USDC → 1234567 base units; the service must forward it verbatim.
    await Erc20Service.transfer(USDC, TO, 1_234_567n)
    const args = (contractWrite as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(args[3]).toEqual([TO, 1_234_567n])
  })

  it('encodes against an erc20Abi that actually contains the transfer fragment', () => {
    // Guards the abis.ts addition: viem can only encodeFunctionData('transfer')
    // if the fragment exists. A missing fragment would make the runtime call
    // throw, so assert its presence here as a cheap regression tripwire.
    const fragment = (erc20Abi as readonly { name?: string; type?: string }[]).find(
      (f) => f.type === 'function' && f.name === 'transfer',
    )
    expect(fragment).toBeDefined()
  })
})
