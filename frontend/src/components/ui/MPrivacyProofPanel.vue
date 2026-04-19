<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { createPublicClient, http, keccak256, toBytes } from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { addresses } from '@/contracts/addresses'
import { muHavenTokenAbi, muHavenVaultAbi } from '@/contracts/abis'
import { useFhe } from '@/composables/useFhe'
import { useWallet } from '@/composables/useWallet'
import * as TokenService from '@/services/contracts/TokenService'
import { arbiscanTx, arbiscanAddress } from '@/lib/external'
import MButton from './MButton.vue'
import MBadge from './MBadge.vue'
import {
  Shield, Lock, Eye, EyeOff, ExternalLink, Loader2,
  AlertTriangle, ScanEye, KeyRound, Globe, FileCode,
  Sparkles,
} from 'lucide-vue-next'

// ── Props ───────────────────────────────────────────────────────────

/**
 * Intent describes the inner function call the user actually triggered.
 * Required because every MuHaven write goes through a ZeroDev ERC-4337
 * userOp — the on-chain `tx.to` is the EntryPoint and `tx.input` is
 * `handleOps([...])`, so we cannot recover the inner mint/wrap by just
 * decoding `tx.input`. Callers (e.g. DepositPage) already know the call
 * they triggered; pass it here verbatim.
 */
export interface ProofIntent {
  contract: 'MuHavenToken' | 'MuHavenVault'
  functionName: 'mint' | 'transfer' | 'wrap' | 'unwrap' | 'approve'
  args: unknown[]
}

const props = withDefaults(defineProps<{
  txHash: string
  /** Collapsed by default. Set true to render expanded. */
  defaultOpen?: boolean
  /**
   * Inner function call the caller submitted. When omitted (e.g. on the
   * Activity page where we only know the hash), the intent section is
   * hidden — log decoding still works because logs are emitted by the
   * actual contracts regardless of who called them.
   */
  intent?: ProofIntent
}>(), {
  defaultOpen: false,
})

// ── Constants ───────────────────────────────────────────────────────

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
// ERC-4337 v0.7 EntryPoint — every ZeroDev userOp lands here, so it is
// always the outer `tx.to` we read from getTransaction().
const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

// Two distinct Transfer event signatures we care about:
//   - Standard ERC-20: amount sits in the data slot (uint256, plaintext)
//   - MuHaven fhERC-20: NO value field at all — the strongest possible
//     proof of privacy. The on-chain log carries only sender + receiver.
// Topics are hashed at module load — no risk of typo'd magic constants.
const TOPIC_TRANSFER_STD = keccak256(toBytes('Transfer(address,address,uint256)'))
const TOPIC_TRANSFER_MUHAVEN = keccak256(toBytes('Transfer(address,address)'))
const TOPIC_APPROVAL_MUHAVEN = keccak256(toBytes('Approval(address,address)'))

// ── Contract metadata ───────────────────────────────────────────────

type ContractKind = 'confidential' | 'public' | 'unknown'

interface ContractMeta {
  name: string
  kind: ContractKind
  symbol?: string
  decimals?: number
  /** Used to read post-tx encrypted balance for the right-side reveal. */
  fheType?: 'uint128' | 'uint64'
  /** ABI used to decode this contract's calldata in the input panel. */
  abi?: readonly unknown[]
}

const META: Record<string, ContractMeta> = {
  [addresses.muHavenToken.toLowerCase()]: {
    name: 'MuHavenToken',
    kind: 'confidential',
    symbol: 'MUH',
    decimals: 18,
    fheType: 'uint128',
    abi: muHavenTokenAbi,
  },
  [addresses.pusdc.toLowerCase()]: {
    name: 'PUSDC (confidential USDC)',
    kind: 'confidential',
    symbol: 'PUSDC',
    decimals: 6,
    fheType: 'uint64',
  },
  [addresses.muHavenVault.toLowerCase()]: {
    name: 'MuHavenVault',
    kind: 'public',
    abi: muHavenVaultAbi,
  },
  [addresses.muhavenEscrow.toLowerCase()]: {
    name: 'MuHavenEscrow',
    kind: 'confidential',
    fheType: 'uint64',
  },
  [addresses.usdc.toLowerCase()]: {
    name: 'USDC',
    kind: 'public',
    symbol: 'USDC',
    decimals: 6,
  },
  [ENTRY_POINT_V07.toLowerCase()]: {
    name: 'ERC-4337 EntryPoint v0.7',
    kind: 'public',
  },
}

function metaFor(addr?: string | null): ContractMeta {
  if (!addr) return { name: 'Unknown contract', kind: 'unknown' }
  return META[addr.toLowerCase()] ?? { name: 'Unknown contract', kind: 'unknown' }
}

// ── Decoded data model ──────────────────────────────────────────────

type EventKind = 'transfer-std' | 'transfer-valueless' | 'approval-valueless' | 'other'

interface ProofEvent {
  kind: EventKind
  contract: string
  contractMeta: ContractMeta
  signature: string
  fromAddress: string
  toAddress: string
  /** Set only when kind === 'transfer-std'. */
  rawValue?: `0x${string}`
  /** Plaintext rendering for std Transfer when emitter is public. */
  plaintext?: string
  /** Right-side reveal: post-tx encrypted balance handle for the recipient. */
  decryptedBalance?: bigint
  decryptingBalance: boolean
  decryptError: string | null
  logIndex: number
}

interface DecodedArg {
  name: string
  type: string
  /** Pretty rendering of the value (string, never raw object). */
  display: string
  /** Confidential = ciphertext input; public = plaintext on-chain forever. */
  kind: 'confidential' | 'public' | 'address' | 'other'
  /** Hex slice that contains the ciphertext handle, if any (for highlighting). */
  ctHashHex?: string
}

interface InputDecode {
  ok: boolean
  contract: ContractMeta
  contractAddress: string
  functionName: string
  args: DecodedArg[]
  rawCalldata: `0x${string}`
  /** Set when ABI decode failed but we have raw calldata. */
  error?: string
}

// ── State ───────────────────────────────────────────────────────────

const open = ref(props.defaultOpen)
const loading = ref(false)
const loadError = ref<string | null>(null)
const events = ref<ProofEvent[]>([])
const outerTxTo = ref<string | null>(null)
const loaded = ref(false)

const { decryptUint128ForView, decryptUint64ForView } = useFhe()
const { address: currentUserAddress } = useWallet()

// ── Public client ───────────────────────────────────────────────────

let _publicClient: ReturnType<typeof createPublicClient> | null = null
function getPublicClient() {
  if (!_publicClient) {
    _publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC_URL) })
  }
  return _publicClient
}

// ── Helpers ─────────────────────────────────────────────────────────

function addressFromTopic(topic: `0x${string}`): string {
  return '0x' + topic.slice(-40)
}

function isZero(addr: string): boolean {
  return addr.toLowerCase() === ZERO_ADDR
}

function formatAddrShort(a: string): string {
  if (!a) return ''
  if (isZero(a)) return '0x0 · burn/mint'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function formatTokenAmount(raw: bigint, decimals: number, symbol = ''): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const frac = raw % divisor
  const fracStr = decimals > 0
    ? frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '')
    : ''
  const base = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString()
  return symbol ? `${base} ${symbol}` : base
}

// ── Calldata decoding ───────────────────────────────────────────────

interface ArgClassification {
  kind: DecodedArg['kind']
  display: string
  ctHashHex?: string
}

/**
 * Classify a decoded function argument as confidential / public / address.
 * Confidential args are encrypted-input tuples whose ctHash is opaque;
 * public args are plaintext on-chain (e.g. wrap amount, ERC-20 approve amount).
 */
function classifyArg(
  funcName: string,
  argType: string,
  value: unknown,
): ArgClassification {
  // Encrypted input tuples: shape { ctHash, securityZone, utype, signature }
  if (
    argType === 'tuple' &&
    value && typeof value === 'object' &&
    'ctHash' in (value as Record<string, unknown>)
  ) {
    const v = value as { ctHash: bigint, securityZone?: number, utype?: number }
    const hex = '0x' + v.ctHash.toString(16).padStart(64, '0')
    return {
      kind: 'confidential',
      display: hex,
      ctHashHex: hex,
    }
  }

  if (argType === 'address') {
    return { kind: 'address', display: typeof value === 'string' ? value : String(value) }
  }

  // Plain numeric — treated as public unless we know otherwise.
  if (argType === 'uint256' || argType === 'uint128' || argType === 'uint64' || argType === 'uint8') {
    const big = typeof value === 'bigint' ? value : BigInt(value as number | string)
    // Heuristic: wrap/unwrap amounts are 18-decimal in this app.
    const decimals = funcName === 'wrap' || funcName === 'unwrap' ? 18 : 0
    return {
      kind: 'public',
      display: decimals > 0 ? `${formatTokenAmount(big, decimals)} (raw: ${big.toString()})` : big.toString(),
    }
  }

  if (argType === 'bool') {
    return { kind: 'public', display: value ? 'true' : 'false' }
  }

  return {
    kind: 'other',
    display: typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v),
  }
}

/**
 * Build an InputDecode from a caller-supplied intent. We look up the function
 * inputs from the contract's ABI to get arg names + types, then classify each
 * arg from the actual value the caller passed.
 */
function decodeIntent(intent: ProofIntent): InputDecode | null {
  const contractAddress = intent.contract === 'MuHavenToken'
    ? addresses.muHavenToken
    : addresses.muHavenVault
  const meta = metaFor(contractAddress)
  if (!meta.abi) return null

  const fnAbi = (meta.abi as { name: string, inputs?: { name: string, type: string }[] }[])
    .find(x => x.name === intent.functionName)
  if (!fnAbi) return null

  const inputs = fnAbi.inputs ?? []
  const args: DecodedArg[] = inputs.map((inp, i) => {
    const value = intent.args[i]
    const cls = classifyArg(intent.functionName, inp.type, value)
    return {
      name: inp.name,
      type: inp.type,
      display: cls.display,
      kind: cls.kind,
      ctHashHex: cls.ctHashHex,
    }
  })

  return {
    ok: true,
    contract: meta,
    contractAddress,
    functionName: intent.functionName,
    args,
    rawCalldata: '0x',
  }
}

const inputDecode = computed<InputDecode | null>(() => {
  if (!props.intent) return null
  return decodeIntent(props.intent)
})

// ── Fetch + decode ──────────────────────────────────────────────────

async function loadReceipt() {
  loading.value = true
  loadError.value = null
  try {
    const client = getPublicClient()

    // Use waitForTransactionReceipt: handles the post-userOp race where the
    // public RPC hasn't yet seen the tx that ZeroDev's bundler just confirmed.
    // Polls with viem's defaults; cap at 30s so the demo never hangs forever.
    // Also fetch the bundler tx so we can show the user honestly that the
    // outer tx.to is the EntryPoint — the inner mint/wrap is wrapped in a
    // userOp and surfaced separately via the `intent` prop.
    const [receipt, tx] = await Promise.all([
      client.waitForTransactionReceipt({
        hash: props.txHash as `0x${string}`,
        timeout: 30_000,
        confirmations: 1,
      }),
      client.getTransaction({ hash: props.txHash as `0x${string}` }),
    ])

    // Decode logs
    const decoded: ProofEvent[] = []
    for (const log of receipt.logs) {
      const topic0 = log.topics[0]
      if (!topic0) continue
      if (log.topics.length < 3) continue

      const from = addressFromTopic(log.topics[1] as `0x${string}`)
      const to = addressFromTopic(log.topics[2] as `0x${string}`)
      const meta = metaFor(log.address)

      let kind: EventKind | null = null
      let signature = ''
      if (topic0 === TOPIC_TRANSFER_STD) {
        kind = 'transfer-std'
        signature = 'Transfer(address indexed from, address indexed to, uint256 value)'
      } else if (topic0 === TOPIC_TRANSFER_MUHAVEN) {
        kind = 'transfer-valueless'
        signature = 'Transfer(address indexed from, address indexed to)'
      } else if (topic0 === TOPIC_APPROVAL_MUHAVEN) {
        kind = 'approval-valueless'
        signature = 'Approval(address indexed owner, address indexed spender)'
      }
      if (!kind) continue

      const evt: ProofEvent = {
        kind,
        contract: log.address,
        contractMeta: meta,
        signature,
        fromAddress: from,
        toAddress: to,
        decryptingBalance: false,
        decryptError: null,
        logIndex: log.logIndex ?? decoded.length,
      }

      if (kind === 'transfer-std') {
        evt.rawValue = log.data as `0x${string}`
        if (meta.kind !== 'confidential') {
          // Fall back to 18 decimals for unknown ERC-20s (e.g. the vault's
          // underlying token isn't in our META map). Surfacing some plaintext
          // beats showing a bare "—" in the demo.
          const dec = meta.decimals ?? 18
          const sym = meta.symbol ?? '(unknown)'
          evt.plaintext = formatTokenAmount(BigInt(evt.rawValue), dec, sym)
        }
      }

      decoded.push(evt)
    }

    events.value = decoded
    outerTxTo.value = tx.to ?? null
    loaded.value = true
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Could not load transaction receipt'
  } finally {
    loading.value = false
  }
}

const outerTxMeta = computed(() => metaFor(outerTxTo.value))

// ── Right-side reveal: decrypt the recipient's post-tx balance ──────

/**
 * Whether the current viewer holds a valid permit to decrypt this event's
 * recipient balance. CoFHE permits are per-address — a viewer can only
 * decrypt handles owned by addresses they hold a permit from. In the
 * self-permit model used here, that means the viewer must equal the
 * recipient (or the contract must have explicitly `FHE.allow`ed the viewer,
 * which our token does not do for arbitrary readers).
 */
function viewerHoldsPermitFor(evt: ProofEvent): boolean {
  const me = currentUserAddress.value
  if (!me) return false
  return me.toLowerCase() === evt.toAddress.toLowerCase()
}

async function revealBalance(idx: number) {
  const evt = events.value[idx]
  if (!evt || evt.contractMeta.kind !== 'confidential') return
  if (evt.decryptingBalance || evt.decryptedBalance !== undefined) return
  // Only meaningful when the recipient is a real address (not burn).
  if (isZero(evt.toAddress)) return

  // Permit guard: the CoFHE coprocessor will reject decryption for a
  // handle the viewer has no permit on. Surface this as a clean message
  // instead of letting the SDK throw a low-level "permit denied" error.
  if (!viewerHoldsPermitFor(evt)) {
    evt.decryptError =
      'You do not hold an FHE permit for this recipient. Only the recipient ' +
      'can decrypt their own balance.'
    return
  }

  evt.decryptingBalance = true
  evt.decryptError = null

  try {
    // Read the recipient's current encrypted balance handle from the contract.
    // For MuHavenToken we have a dedicated service helper; other confidential
    // contracts would need their own read here.
    const isMuHavenToken =
      evt.contract.toLowerCase() === addresses.muHavenToken.toLowerCase()

    if (!isMuHavenToken) {
      throw new Error(
        'Balance reveal is implemented for MuHavenToken only in this demo. ' +
        'Other confidential contracts will plug in via their own service.',
      )
    }

    const handle = await TokenService.encryptedBalanceOf(evt.toAddress as `0x${string}`)
    const decryptor = evt.contractMeta.fheType === 'uint64'
      ? decryptUint64ForView
      : decryptUint128ForView
    evt.decryptedBalance = await decryptor(handle)
  } catch (e) {
    evt.decryptError = e instanceof Error ? e.message : 'Decrypt failed'
  } finally {
    evt.decryptingBalance = false
  }
}

function formatBalance(evt: ProofEvent): string {
  if (evt.decryptedBalance === undefined) return ''
  const dec = evt.contractMeta.decimals ?? 18
  return formatTokenAmount(evt.decryptedBalance, dec, evt.contractMeta.symbol)
}

// ── UI behaviour ────────────────────────────────────────────────────

function toggle() {
  open.value = !open.value
  if (open.value && !loaded.value && !loading.value) {
    loadReceipt()
  }
}

onMounted(() => {
  if (props.defaultOpen) loadReceipt()
})

// Reset full local state on hash change (including loading) so a stale
// in-flight fetch doesn't block the new one.
watch(() => props.txHash, () => {
  events.value = []
  outerTxTo.value = null
  loaded.value = false
  loadError.value = null
  loading.value = false
  if (open.value) loadReceipt()
})

// ── Narrative ───────────────────────────────────────────────────────

const valuelessCount = computed(() => events.value.filter(e => e.kind === 'transfer-valueless').length)
const standardConfidentialCount = computed(() =>
  events.value.filter(e => e.kind === 'transfer-std' && e.contractMeta.kind === 'confidential').length,
)
const publicTransferCount = computed(() =>
  events.value.filter(e => e.kind === 'transfer-std' && e.contractMeta.kind !== 'confidential').length,
)
const confidentialCount = computed(() => valuelessCount.value + standardConfidentialCount.value)

const headline = computed(() => {
  if (valuelessCount.value > 0 && publicTransferCount.value === 0) {
    return 'Transfer event was emitted with NO amount field — the chain never sees the number.'
  }
  if (valuelessCount.value > 0 && publicTransferCount.value > 0) {
    return `${publicTransferCount.value} public ERC-20 transfer${publicTransferCount.value > 1 ? 's' : ''} → ${valuelessCount.value} valueless confidential transfer${valuelessCount.value > 1 ? 's' : ''}. Privacy boundary visible in one tx.`
  }
  if (publicTransferCount.value > 0) {
    return 'Only public ERC-20 transfers detected — no confidential events in this transaction.'
  }
  return 'No relevant Transfer events decoded.'
})
</script>

<template>
  <div
    data-testid="privacy-proof-panel"
    :data-tx-hash="txHash"
    class="rounded-xl border border-compute/20 bg-gradient-to-br from-compute/5 via-transparent to-cipher/5 dark:from-compute/8 dark:to-cipher/8 overflow-hidden"
  >
    <!-- Header / toggle -->
    <button
      type="button"
      @click="toggle"
      data-testid="privacy-proof-toggle"
      :aria-expanded="open"
      class="w-full flex items-center gap-3 px-4 py-3 hover:bg-compute/5 transition-colors cursor-pointer text-left"
    >
      <div class="w-9 h-9 rounded-lg bg-compute/12 flex items-center justify-center shrink-0">
        <ScanEye :size="16" class="text-compute" />
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-sans font-semibold text-midnight dark:text-white">
          Prove this transaction is private
        </p>
        <p class="text-[11px] text-cool">
          Compare what anyone sees on Arbiscan vs. what your permit unlocks locally.
        </p>
      </div>
      <span class="text-[11px] font-sans text-compute font-medium">
        {{ open ? 'Hide' : 'Show' }}
      </span>
    </button>

    <!-- Body -->
    <transition
      enter-active-class="transition-opacity duration-300 ease-out"
      leave-active-class="transition-opacity duration-200 ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-show="open" class="border-t border-compute/15">
        <!-- Loading -->
        <div v-if="loading" class="flex items-center gap-2 px-4 py-6 text-sm text-cool">
          <Loader2 :size="16" class="animate-spin text-compute" />
          Reading transaction receipt + calldata…
        </div>

        <!-- Error -->
        <div
          v-else-if="loadError"
          class="flex items-start gap-2.5 m-4 px-4 py-3 rounded-lg bg-negative/8 border border-negative/15"
        >
          <AlertTriangle :size="14" class="text-negative shrink-0 mt-0.5" />
          <div class="flex-1">
            <p class="text-xs font-sans text-negative leading-relaxed">{{ loadError }}</p>
            <button
              @click="loadReceipt"
              class="mt-2 text-[11px] text-negative hover:underline cursor-pointer"
            >Retry</button>
          </div>
        </div>

        <!-- Loaded -->
        <div v-else-if="loaded" class="px-4 py-4">
          <!-- Headline + summary -->
          <div class="flex flex-wrap items-center gap-2 mb-4">
            <MBadge variant="privacy" v-if="confidentialCount > 0">
              <Lock :size="10" class="mr-1" />
              {{ confidentialCount }} confidential
            </MBadge>
            <MBadge v-if="publicTransferCount > 0" variant="default">
              <Globe :size="10" class="mr-1" />
              {{ publicTransferCount }} public
            </MBadge>
            <span class="text-[11px] text-cool font-sans flex-1 min-w-[200px]">{{ headline }}</span>
            <a
              :href="arbiscanTx(txHash)"
              target="_blank"
              rel="noopener"
              data-testid="privacy-proof-arbiscan"
              class="inline-flex items-center gap-1 text-[11px] font-mono text-compute hover:underline"
            >
              View on Arbiscan
              <ExternalLink :size="10" />
            </a>
          </div>

          <!-- ── Section 1: The user's intent (decoded from prop) ─────── -->
          <!-- We can't recover this from tx.input because every MuHaven write
               is wrapped in an ERC-4337 userOp via ZeroDev. The EntryPoint is
               the actual tx.to; the real call is delivered via handleOps().
               The caller (e.g. DepositPage) passes the inner call as `intent`. -->
          <div
            v-if="inputDecode"
            class="grid grid-cols-1 md:grid-cols-2 gap-0 rounded-lg overflow-hidden border border-haze/70 dark:border-white/8 mb-4"
            data-testid="privacy-proof-input"
          >
            <!-- LEFT: The decoded intent -->
            <div class="bg-mist/60 dark:bg-midnight/40 p-4 border-b md:border-b-0 md:border-r border-haze/70 dark:border-white/8">
              <div class="flex items-center gap-1.5 mb-3">
                <FileCode :size="12" class="text-cool" />
                <span class="text-[10px] uppercase tracking-wider text-cool font-sans font-medium">
                  Your intent (decoded)
                </span>
              </div>

              <div class="text-[11px] font-sans text-slate dark:text-cool mb-2">
                <span class="text-cool">target</span>
                <a
                  :href="arbiscanAddress(inputDecode.contractAddress)"
                  target="_blank"
                  rel="noopener"
                  class="ml-1 font-medium text-midnight dark:text-white hover:text-compute transition-colors"
                >
                  {{ inputDecode.contract.name }}
                </a>
              </div>

              <p class="text-[11px] font-mono text-midnight dark:text-white mb-3 break-all">
                <span class="text-compute font-semibold">{{ inputDecode.functionName }}</span>(
              </p>

              <div v-if="inputDecode.ok && inputDecode.args.length > 0" class="space-y-2 pl-3">
                <div
                  v-for="arg in inputDecode.args"
                  :key="arg.name"
                  class="rounded-md p-2.5"
                  :class="arg.kind === 'confidential' ? 'bg-cipher/8 ring-1 ring-cipher/25' : 'bg-white/60 dark:bg-midnight/40 ring-1 ring-haze/60 dark:ring-white/8'"
                >
                  <div class="flex items-center gap-1.5 mb-1">
                    <Lock v-if="arg.kind === 'confidential'" :size="10" class="text-cipher" />
                    <Eye v-else :size="10" class="text-cool" />
                    <span class="text-[10px] font-mono" :class="arg.kind === 'confidential' ? 'text-cipher font-semibold' : 'text-slate dark:text-cool'">
                      {{ arg.type }} {{ arg.name }}
                    </span>
                    <span
                      v-if="arg.kind === 'confidential'"
                      class="ml-auto text-[9px] uppercase tracking-wider text-cipher font-semibold"
                    >ciphertext input</span>
                    <span
                      v-else-if="arg.kind === 'public' && inputDecode.functionName !== 'mint'"
                      class="ml-auto text-[9px] uppercase tracking-wider text-cool font-semibold"
                    >plaintext</span>
                  </div>
                  <p
                    class="text-[11px] font-mono break-all leading-relaxed"
                    :class="arg.kind === 'confidential' ? 'text-cipher' : 'text-midnight dark:text-white'"
                  >
                    {{ arg.display }}
                  </p>
                  <p
                    v-if="arg.kind === 'confidential'"
                    class="text-[10px] font-sans text-cool mt-1.5 leading-relaxed"
                  >
                    32-byte handle into the CoFHE coprocessor + zero-knowledge proof
                    that the encryptor knew a valid plaintext. <em>The plaintext
                    amount is never in the calldata.</em>
                  </p>
                </div>
              </div>

              <p class="text-[11px] font-mono text-midnight dark:text-white mt-2">)</p>

              <p
                v-if="!inputDecode.ok"
                class="text-[11px] font-sans text-cool mt-2 italic"
              >{{ inputDecode.error }}</p>
            </div>

            <!-- RIGHT: Narrative + ZeroDev disclosure -->
            <div class="bg-white/70 dark:bg-compute/6 p-4">
              <div class="flex items-center gap-1.5 mb-3">
                <Sparkles :size="12" class="text-compute" />
                <span class="text-[10px] uppercase tracking-wider text-compute font-sans font-medium">
                  What this means
                </span>
              </div>
              <p class="text-[11px] text-cool font-sans leading-relaxed mb-3">
                <template v-if="inputDecode.functionName === 'mint' || inputDecode.functionName === 'transfer'">
                  The amount you typed in the UI was encrypted in your browser via the
                  Fhenix tfhe WASM, wrapped with a zero-knowledge proof, and submitted
                  as the <strong class="text-midnight dark:text-white font-medium">ctHash</strong>
                  pointer above. A normal ERC-20 mint would have included the plaintext
                  amount as a uint256 — anyone watching the mempool would have seen it.
                </template>
                <template v-else-if="inputDecode.functionName === 'wrap'">
                  Vault wrap is the privacy <strong class="text-midnight dark:text-white font-medium">boundary</strong>:
                  the plaintext amount must be visible here so the vault can pull the
                  underlying ERC-20. Once wrapped, every future movement of the
                  resulting fhERC-20 balance is confidential.
                </template>
                <template v-else>
                  The decoded input above is the call you submitted. Logs below
                  show what landed on-chain.
                </template>
              </p>

              <!-- Honest framing: this call is wrapped in a userOp on-chain. -->
              <div class="mt-3 pt-3 border-t border-haze/70 dark:border-white/8">
                <p class="text-[10px] font-sans text-cool leading-relaxed">
                  <strong class="text-midnight dark:text-white font-medium">On-chain reality:</strong>
                  submitted inside an ERC-4337 userOp via ZeroDev. The outer
                  <code class="font-mono">tx.to</code> on Arbiscan is
                  <span class="font-mono text-midnight dark:text-white" v-if="outerTxTo">
                    {{ outerTxMeta.name }} ({{ formatAddrShort(outerTxTo) }})</span>
                  <span class="font-mono" v-else>the bundler EntryPoint</span>,
                  not MuHaven directly — the inner call is delivered through
                  <code class="font-mono">handleOps()</code>. The events below
                  are still emitted by the real MuHaven contracts.
                </p>
              </div>
            </div>
          </div>

          <!-- ── Section 2: Per-event proof ────────────────────────────── -->
          <p class="text-[10px] uppercase tracking-wider text-cool font-sans font-medium mb-2 mt-4">
            Event logs ({{ events.length }})
          </p>

          <div v-if="events.length === 0" class="text-xs text-cool py-4 text-center rounded-lg border border-dashed border-haze dark:border-white/10">
            No Transfer / Approval events decoded for this transaction.
          </div>

          <div v-else class="flex flex-col gap-4">
            <div
              v-for="(evt, i) in events"
              :key="evt.logIndex"
              data-testid="privacy-proof-event"
              :data-confidential="evt.contractMeta.kind === 'confidential' ? '1' : '0'"
              :data-kind="evt.kind"
              class="grid grid-cols-1 md:grid-cols-2 gap-0 rounded-lg overflow-hidden border border-haze/70 dark:border-white/8"
            >
              <!-- LEFT: Public view (Arbiscan) -->
              <div class="bg-mist/60 dark:bg-midnight/40 p-4 border-b md:border-b-0 md:border-r border-haze/70 dark:border-white/8">
                <div class="flex items-center gap-1.5 mb-3">
                  <Globe :size="12" class="text-cool" />
                  <span class="text-[10px] uppercase tracking-wider text-cool font-sans font-medium">
                    Public view · Arbiscan log
                  </span>
                </div>

                <!-- Emitter -->
                <div class="text-[11px] font-sans text-slate dark:text-cool mb-2">
                  <span class="text-cool">emitted by</span>
                  <a
                    :href="arbiscanAddress(evt.contract)"
                    target="_blank"
                    rel="noopener"
                    class="ml-1 font-medium text-midnight dark:text-white hover:text-compute transition-colors"
                  >
                    {{ evt.contractMeta.name }}
                  </a>
                </div>

                <!-- Signature -->
                <p class="text-[11px] font-mono text-slate dark:text-cool mb-2 break-all">
                  {{ evt.signature }}
                </p>

                <!-- From → To with mint/burn labels -->
                <div class="flex items-center gap-2 text-[11px] font-mono text-slate dark:text-cool mb-3 flex-wrap">
                  <span
                    class="px-1.5 py-0.5 rounded"
                    :class="isZero(evt.fromAddress) ? 'bg-gold/15 text-gold font-semibold' : 'bg-white/70 dark:bg-midnight/60'"
                  >
                    {{ isZero(evt.fromAddress) ? 'mint' : formatAddrShort(evt.fromAddress) }}
                  </span>
                  <span class="text-cool">→</span>
                  <span
                    class="px-1.5 py-0.5 rounded"
                    :class="isZero(evt.toAddress) ? 'bg-gold/15 text-gold font-semibold' : 'bg-white/70 dark:bg-midnight/60'"
                  >
                    {{ isZero(evt.toAddress) ? 'burn' : formatAddrShort(evt.toAddress) }}
                  </span>
                </div>

                <!-- Value slot -->
                <!-- Case 1: standard ERC-20 Transfer with value -->
                <div
                  v-if="evt.kind === 'transfer-std'"
                  class="rounded-md p-3"
                  :class="evt.contractMeta.kind === 'confidential' ? 'bg-cipher/8 ring-1 ring-cipher/25' : 'bg-gold/8 ring-1 ring-gold/25'"
                >
                  <div class="flex items-center gap-1.5 mb-1.5">
                    <Lock v-if="evt.contractMeta.kind === 'confidential'" :size="10" class="text-cipher" />
                    <Eye v-else :size="10" class="text-gold" />
                    <span
                      class="text-[10px] uppercase tracking-wider font-sans font-semibold"
                      :class="evt.contractMeta.kind === 'confidential' ? 'text-cipher' : 'text-gold'"
                    >
                      {{ evt.contractMeta.kind === 'confidential' ? 'euint128 handle — ciphertext pointer' : 'uint256 value — plaintext amount' }}
                    </span>
                  </div>
                  <p class="text-[11px] font-mono break-all leading-relaxed" :class="evt.contractMeta.kind === 'confidential' ? 'text-cipher' : 'text-gold'">
                    {{ evt.rawValue }}
                  </p>
                  <p v-if="evt.plaintext" class="text-[10px] font-sans text-cool mt-1.5">
                    Decoded: <span class="font-mono text-midnight dark:text-white">{{ evt.plaintext }}</span>
                  </p>
                </div>

                <!-- Case 2: MuHaven valueless Transfer — the strongest proof -->
                <div
                  v-else-if="evt.kind === 'transfer-valueless'"
                  class="rounded-md p-3 bg-cipher/6 ring-1 ring-cipher/25 border-l-2 border-cipher"
                  data-testid="privacy-proof-valueless-slot"
                >
                  <div class="flex items-center gap-1.5 mb-1.5">
                    <Lock :size="10" class="text-cipher" />
                    <span class="text-[10px] uppercase tracking-wider text-cipher font-sans font-semibold">
                      No value field
                    </span>
                  </div>
                  <!-- Visual "missing slot" -->
                  <div class="flex items-center gap-2 py-2">
                    <span class="text-[11px] font-mono text-cool/40 line-through">value: 0x…</span>
                    <span class="text-[10px] font-sans text-cipher font-semibold">never emitted</span>
                  </div>
                  <p class="text-[10px] font-sans text-cool mt-1 leading-relaxed">
                    A standard ERC-20 Transfer would carry a third
                    <code class="font-mono">uint256 value</code> in the data
                    slot. MuHaven's confidential Transfer event omits the
                    parameter entirely — the amount of <em>this specific
                    transfer</em> never exists on-chain in any form, encrypted
                    or otherwise.
                  </p>
                </div>

                <!-- Case 3: Approval — informational only -->
                <div v-else class="rounded-md p-3 bg-mist dark:bg-midnight/60">
                  <p class="text-[10px] font-sans text-cool">
                    Approval events on MuHavenToken are also valueless — only
                    owner + spender are recorded.
                  </p>
                </div>
              </div>

              <!-- RIGHT: Your view -->
              <div class="bg-white/70 dark:bg-compute/6 p-4">
                <div class="flex items-center gap-1.5 mb-3">
                  <KeyRound :size="12" class="text-compute" />
                  <span class="text-[10px] uppercase tracking-wider text-compute font-sans font-medium">
                    Your view · permit-decrypted locally
                  </span>
                </div>

                <!-- Confidential MuHaven valueless Transfer:
                     nothing in this log to decrypt. Offer to reveal the
                     recipient's *current* encrypted balance instead. -->
                <template v-if="evt.kind === 'transfer-valueless' && evt.contractMeta.kind === 'confidential'">
                  <p class="text-[11px] text-cool font-sans leading-relaxed mb-3">
                    There is nothing to reveal from this log — the amount was
                    never emitted. To verify the transfer landed, decrypt the
                    recipient's <strong class="text-midnight dark:text-white font-medium">post-tx balance</strong>
                    via <code class="font-mono">encryptedBalanceOf({{ formatAddrShort(evt.toAddress) }})</code>.
                  </p>

                  <div v-if="evt.decryptedBalance !== undefined">
                    <div class="rounded-md p-3 bg-compute/8 ring-1 ring-compute/30 mb-2">
                      <p class="text-[10px] uppercase tracking-wider text-compute font-sans font-semibold mb-1">
                        Recipient's balance (decrypted)
                      </p>
                      <p
                        data-testid="privacy-proof-decrypted-balance"
                        class="text-xl font-accent italic text-midnight dark:text-white"
                      >{{ formatBalance(evt) }}</p>
                    </div>
                    <p class="text-[10px] text-cool font-sans leading-relaxed">
                      Decrypted by the CoFHE coprocessor under your self-permit.
                      The plaintext exists only in this browser tab.
                    </p>
                  </div>

                  <div v-else-if="evt.decryptingBalance" class="flex items-center gap-2 text-sm text-cool py-3">
                    <Loader2 :size="14" class="animate-spin text-compute" />
                    Reading + decrypting balance…
                  </div>

                  <div v-else>
                    <MButton
                      variant="primary"
                      size="sm"
                      full-width
                      data-testid="privacy-proof-reveal-balance-cta"
                      :disabled="isZero(evt.toAddress)"
                      @click="revealBalance(i)"
                    >
                      <Eye :size="12" />
                      Decrypt recipient's balance
                    </MButton>
                    <p v-if="evt.decryptError" class="text-[10px] text-negative font-sans mt-2 leading-relaxed">
                      {{ evt.decryptError }}
                    </p>
                    <p v-else class="text-[10px] text-cool font-sans mt-2 leading-relaxed">
                      Only addresses holding a valid FHE permit from the
                      ciphertext owner can ask the coprocessor to reveal a
                      handle. No permit, no plaintext.
                    </p>
                  </div>
                </template>

                <!-- Standard ERC-20 confidential Transfer with handle (PUSDC-style) -->
                <template v-else-if="evt.kind === 'transfer-std' && evt.contractMeta.kind === 'confidential'">
                  <p class="text-[11px] text-cool font-sans leading-relaxed mb-2">
                    The value slot above is a ciphertext handle — the plaintext
                    amount lives in the CoFHE coprocessor and only permit-holders
                    can read it.
                  </p>
                  <p class="text-[10px] text-cool font-sans italic">
                    Per-tx amount reveal for {{ evt.contractMeta.name }} is not
                    wired in this build — see Wave 4.
                  </p>
                </template>

                <!-- Public ERC-20 — honest disclosure -->
                <template v-else-if="evt.kind === 'transfer-std'">
                  <div class="rounded-md p-3 bg-gold/5 ring-1 ring-gold/20 mb-2">
                    <div class="flex items-center gap-1.5 mb-1">
                      <EyeOff :size="10" class="text-gold" />
                      <p class="text-[10px] uppercase tracking-wider text-gold font-sans font-semibold">
                        No secret here
                      </p>
                    </div>
                    <p class="text-xl font-accent italic text-midnight dark:text-white">
                      {{ evt.plaintext ?? '—' }}
                    </p>
                  </div>
                  <p class="text-[10px] text-cool font-sans leading-relaxed">
                    Standard ERC-20 transfer — amount is public by design.
                    MuHaven wraps it into a confidential balance in the same tx
                    so future movements stay private.
                  </p>
                </template>

                <!-- Approval -->
                <template v-else>
                  <p class="text-[11px] text-cool font-sans leading-relaxed">
                    Approval events grant another address the right to spend on
                    your behalf. MuHaven's variant carries no allowance amount —
                    the limit lives encrypted in contract storage.
                  </p>
                </template>
              </div>
            </div>
          </div>

          <!-- Footer: how it works -->
          <div class="mt-5 pt-4 border-t border-haze/70 dark:border-white/8">
            <div class="flex items-start gap-2.5">
              <Shield :size="14" class="text-compute shrink-0 mt-0.5" />
              <p class="text-[11px] text-cool font-sans leading-relaxed">
                <strong class="text-midnight dark:text-white font-medium">How it works:</strong>
                Fhenix CoFHE keeps every confidential amount as an
                <code class="px-1 py-0.5 rounded bg-mist dark:bg-midnight font-mono text-[10px]">euint128</code>
                ciphertext in a coprocessor. MuHaven's contracts go one step further
                and emit Transfer events with <em>no value field at all</em> — even
                the ciphertext handle stays out of the public log. Balances live in
                contract storage and are revealed only to addresses holding a valid
                FHE permit.
              </p>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>
