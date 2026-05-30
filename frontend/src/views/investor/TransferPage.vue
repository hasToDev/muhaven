<script setup lang="ts">
import { ref, computed, onMounted, onDeactivated, watch } from 'vue'
import { toast } from 'vue-sonner'
import { isAddress } from 'viem'
import { IdentityRegistryClient } from '@muhaven/sdk'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { useMarketplaceStore } from '@/stores/marketplace'
import { usePortfolioStore } from '@/stores/portfolio'
import * as TokenService from '@/services/contracts/TokenService'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildReadContext } from '@/services/v35/context'
import { arbiscanTx } from '@/lib/external'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import {
  CheckCircle2, Lock, Send, ShieldCheck, AlertTriangle, Loader2, ArrowRight,
  ChevronDown, UserCheck, UserX,
} from 'lucide-vue-next'

// TransferPage — P2P MuHavenToken.transfer with IdentityRegistry.isVerified
// pre-flight. Simulation-first: we read the recipient's KYC state + dev-mode
// flag before signing so the user sees why a transfer would revert instead of
// burning gas on a guaranteed-revert tx.

// WS-1 perf: this page is <keep-alive>d (App.vue KEEP_ALIVE_PAGES) so a
// re-visit reactivates the cached instance instead of re-mounting + re-running
// the marketplace fetch + re-animating the card. Load is REST-only (no on-chain
// reads on mount) and the page arms no event watchers, so no debounce/throttle
// is needed — only the simulation debounce timer is torn down on deactivate.
defineOptions({ name: 'TransferPage' })

const { address } = useWallet()
const { encryptUint128, getEphemeralEOA } = useFhe()
const marketplace = useMarketplaceStore()
const portfolio = usePortfolioStore()

const recipient = ref('')
const amount = ref('')
const selectedToken = ref<string>('')
const isProcessing = ref(false)
const txHash = ref<string | null>(null)
const showSuccess = ref(false)
const errMsg = ref<string | null>(null)

const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)
const recipientAddressValid = computed(() => isAddress(recipient.value))

onMounted(async () => {
  if (!marketplace.loaded) await marketplace.load()
  if (marketplace.filtered.length > 0 && !selectedToken.value) {
    selectedToken.value = marketplace.filtered[0].address
  }
})

// ── Simulation ──────────────────────────────────────────────────────────

type SimState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; message: string }
  | { kind: 'blocked'; reason: string }

const simState = ref<SimState>({ kind: 'idle' })

/**
 * Pre-flight: recipient validity → IdentityRegistry.isVerified (or dev-mode
 * bypass). Self-transfer and zero address are caught client-side. Full
 * compliance-module simulation is a deferred feature — X-D in
 * DEFERRED_FEATURES.md covers the issuer-side "why did this revert?" panel.
 */
async function runSimulation() {
  errMsg.value = null

  if (!recipient.value) {
    simState.value = { kind: 'idle' }
    return
  }
  if (!recipientAddressValid.value) {
    simState.value = { kind: 'blocked', reason: 'Not a valid address' }
    return
  }
  if (
    address.value
    && recipient.value.toLowerCase() === address.value.toLowerCase()
  ) {
    simState.value = { kind: 'blocked', reason: 'Cannot transfer to self' }
    return
  }

  simState.value = { kind: 'checking' }

  if (isZeroAddress(v35Addresses.identityRegistry)) {
    // Wave 3.5 registry not yet configured — fall back to optimistic "proceed"
    // rather than blocking the whole page. Real cutover sets the env var.
    simState.value = {
      kind: 'ok',
      message: 'IdentityRegistry not configured — simulation skipped (dev build)',
    }
    return
  }

  try {
    const identity = new IdentityRegistryClient(
      buildReadContext(),
      v35Addresses.identityRegistry,
    )
    const [isVerified, devMode] = await Promise.all([
      identity.isVerified(recipient.value as `0x${string}`),
      identity.devMode(),
    ])
    if (isVerified) {
      simState.value = { kind: 'ok', message: 'Recipient is KYC-verified' }
    } else if (devMode) {
      simState.value = {
        kind: 'ok',
        message: 'Dev-mode active — KYC bypassed (recipient is NOT actually verified)',
      }
    } else {
      simState.value = {
        kind: 'blocked',
        reason: 'Recipient is not KYC-verified — transfer would revert with RecipientNotKYC',
      }
    }
  } catch (e) {
    simState.value = {
      kind: 'blocked',
      reason: `Simulation failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

// Debounced simulation on recipient change.
let simTimer: ReturnType<typeof setTimeout> | null = null
watch(recipient, () => {
  if (simTimer) clearTimeout(simTimer)
  simTimer = setTimeout(runSimulation, 300)
})

// keep-alive: cancel a pending debounced simulation when the page is
// backgrounded so it can't fire a stray RPC read on a hidden page. Also reset
// a completed/failed transfer's success/error card so a return to the cached
// page lands on a fresh form, not a stale "Transfer submitted" card. An
// in-flight tx (isProcessing) keeps its state untouched.
onDeactivated(() => {
  if (simTimer) { clearTimeout(simTimer); simTimer = null }
  if (!isProcessing.value && (showSuccess.value || errMsg.value)) resetForm()
})

// ── Transfer handler ────────────────────────────────────────────────────

async function handleTransfer() {
  if (isProcessing.value || !address.value) return
  if (!recipientAddressValid.value || numericAmount.value <= 0) return
  if (!selectedToken.value) return
  if (simState.value.kind === 'blocked') return

  isProcessing.value = true
  errMsg.value = null

  try {
    // Raw integer share units per Wave 3.5 convention (see BuyPage note).
    const amt = BigInt(Math.floor(numericAmount.value))
    // Bind the encryption to the kernel address. The on-chain
    // `MuHavenToken.transfer` calls `FHE.asEuint128(input)`, and cofhe's
    // TaskManager recovers the verifier-signature signer to compare against
    // `msg.sender` of that call (= the kernel/smart-account address, since
    // the UserOp routes kernel → MuHavenToken). Without `senderAccount` the
    // cofhe SDK signs with its connected wallet client's account — the
    // per-session ephemeral EOA — and the recovered signer doesn't match
    // `msg.sender`, surfacing as `InvalidSigner` (selector `0x7ba5ffb5`)
    // and a misleading "VerificationGasLimitTooLowError" wrapper from viem.
    // Same fix shape as the SDK-side `withSenderAccount` wrapper in
    // `services/v35/context.ts`; the SDK clients (Subscription / Stable /
    // YieldSnapshot) inherit it through `buildWriteContext`. TransferPage
    // bypasses the SDK and goes straight to `TokenService`, so it has to
    // bind the encryption itself.
    const encrypted = await encryptUint128(amt, {
      senderAccount: address.value as `0x${string}`,
    })
    const ephemeralEOA = getEphemeralEOA()

    // Pass the per-RWA token address — Wave 3.5 onboards each RWA as its own
    // MuHavenToken proxy (TBILL1, GOLD1, …); defaulting to the Wave 3 single-
    // token proxy targets a contract the user has zero balance on and whose
    // ABI may lack the 3-arg transfer overload. Symptom: empty `0x` revert
    // during eth_estimateUserOperationGas, error toast "User operation
    // failed: MuHavenToken.transfer()". Same shape as the 0be4850 fix on
    // /trade Sell-Reveal — every per-RWA service caller needs the address.
    const hash = await TokenService.transferWithEphemeral(
      recipient.value as `0x${string}`,
      encrypted as any,
      ephemeralEOA,
      selectedToken.value as `0x${string}`,
    )
    txHash.value = hash
    showSuccess.value = true
    toast.success('Transfer submitted', {
      description: 'Encrypted share transfer — amount stays in ciphertext',
    })

    // Refresh sender's holdings so /portfolio shows the post-transfer state
    // without a manual reload. Mirrors `refreshAfterTrade` on /trade. We
    // capture which token was transferred + whether it was decrypted
    // pre-transfer; after `portfolio.load()` rebuilds the holdings array
    // (and resets every `decryptedBalance` to null), we re-decrypt only
    // the affected token if the user had previously revealed it. Failures
    // here mustn't mask the on-chain success card — caught + warned.
    await refreshAfterTransfer(selectedToken.value as `0x${string}`)
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'Transfer failed'
    toast.error('Transfer failed', { description: errMsg.value })
  } finally {
    isProcessing.value = false
  }
}

function resetForm() {
  recipient.value = ''
  amount.value = ''
  txHash.value = null
  showSuccess.value = false
  errMsg.value = null
  simState.value = { kind: 'idle' }
}

/**
 * Sender-side post-transfer refresh. The on-chain `_balances[from]` handle
 * rotates after every transfer (`FHE.sub` produces a fresh ciphertext), so
 * any cached `decryptedBalance` on the sender's holding is stale until we
 * re-fetch + re-decrypt. Mirrors `refreshAfterTrade` on TradePage.
 *
 * Steps:
 *  1. Snapshot whether the affected holding was decrypted pre-transfer.
 *  2. `portfolio.load()` to rebuild the holdings array (this resets every
 *     `decryptedBalance` to null by design).
 *  3. If the holding was previously decrypted, re-decrypt it via the
 *     store action so /portfolio shows the post-transfer balance without
 *     a second click. We DO NOT auto-decrypt holdings that were locked
 *     before the transfer — no surprise session signature for a value
 *     the user never asked to see.
 *  4. Failures swallowed + logged; the on-chain success card mustn't be
 *     masked by a refresh hiccup.
 */
async function refreshAfterTransfer(tokenAddress: `0x${string}`) {
  if (!address.value) return
  const addr = address.value as `0x${string}`
  const lower = tokenAddress.toLowerCase()
  const wasRevealed = portfolio.holdings.some(
    h => h.tokenAddress.toLowerCase() === lower && h.decryptedBalance !== null,
  )
  try {
    await portfolio.load(addr)
  } catch (e) {
    console.warn('[TransferPage] portfolio.load post-transfer failed', e)
  }
  if (wasRevealed) {
    const idx = portfolio.holdings.findIndex(
      h => h.tokenAddress.toLowerCase() === lower,
    )
    if (idx >= 0) {
      try {
        await portfolio.decryptHolding(idx, addr)
      } catch (e) {
        console.warn('[TransferPage] holding re-decrypt post-transfer failed', e)
      }
    }
  }
}

const canSubmit = computed(() =>
  !isProcessing.value
  && recipientAddressValid.value
  && numericAmount.value > 0
  && !!selectedToken.value
  && simState.value.kind === 'ok',
)

// Cold-load gate: show the branded loader until the token catalog (REST) is
// ready, so the first visit doesn't flash an empty form + token picker. The
// store flag stays true after the first fetch, so a keep-alive re-entry skips
// the loader entirely (instant). On a load failure we drop through to the form
// (empty picker) rather than spin forever.
const showColdLoader = computed(() => !marketplace.loaded && !marketplace.error)
</script>

<template>
  <div class="max-w-2xl mx-auto">
    <MPageLoader v-if="showColdLoader" label="Loading transfer" caption="Fetching your tokens" />
    <template v-else>
    <header class="mb-8">
      <h1 class="font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tracking-tight">
        Send Shares
      </h1>
      <p class="font-sans text-sm text-cool mt-2 max-w-md leading-relaxed">
        Peer-to-peer encrypted transfer. Amount stays in ciphertext end-to-end; the
        recipient's KYC status is checked before signing.
      </p>
    </header>

    <section
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
      class="relative rounded-2xl overflow-hidden border border-haze dark:border-white/5
             bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-lg
             shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
             dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]
             p-8 md:p-10"
    >
      <div aria-hidden="true"
           class="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-gold/60 dark:via-signal/50 to-transparent" />

      <!-- Success -->
      <div v-if="showSuccess" data-testid="transfer-success-card" class="flex flex-col items-center gap-5 py-6">
        <div
          v-motion
          :initial="{ opacity: 0, scale: 0.5 }"
          :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
          class="w-16 h-16 rounded-full bg-positive/15 border border-positive/30 flex items-center justify-center"
        >
          <CheckCircle2 :size="32" :stroke-width="1.8" class="text-positive" />
        </div>
        <div class="text-center space-y-1.5">
          <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">Transfer sent</p>
          <p class="font-sans text-sm text-cool max-w-md">
            The encrypted amount left your balance — only you and the recipient can decrypt the values.
          </p>
        </div>
        <p v-if="txHash" class="font-mono text-[11px] text-cool">
          tx:
          <a :href="arbiscanTx(txHash)" target="_blank" rel="noopener"
             class="text-compute dark:text-signal hover:underline">
            {{ txHash.slice(0, 10) }}…{{ txHash.slice(-8) }}
          </a>
        </p>
        <MButton variant="outline" @click="resetForm">Send another transfer</MButton>
      </div>

      <!-- Error -->
      <div v-else-if="errMsg" data-testid="transfer-error-card" class="flex flex-col items-center gap-5 py-8">
        <div class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center">
          <Lock :size="26" :stroke-width="1.8" class="text-negative" />
        </div>
        <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">Something went wrong</p>
        <p class="font-sans text-sm text-cool text-center max-w-md">{{ errMsg }}</p>
        <MButton variant="outline" @click="resetForm">Try again</MButton>
      </div>

      <!-- Form -->
      <div v-else class="flex flex-col gap-8">
        <!-- Token selector -->
        <div v-if="marketplace.filtered.length > 0" class="flex flex-col gap-3">
          <label for="transfer-token-select" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">Token</label>
          <div class="relative">
            <select
              id="transfer-token-select"
              v-model="selectedToken"
              :disabled="isProcessing"
              data-testid="transfer-token-select"
              class="w-full bg-transparent border-0 border-b border-haze dark:border-white/10
                     text-midnight dark:text-white font-sans text-sm md:text-base py-3 pl-1 pr-10
                     focus:outline-none focus:border-gold dark:focus:border-signal
                     transition-colors appearance-none cursor-pointer disabled:opacity-50"
            >
              <option v-for="t in marketplace.filtered" :key="t.address" :value="t.address">
                {{ t.name }} ({{ t.symbol }})
              </option>
            </select>
            <ChevronDown :size="16" :stroke-width="1.6" class="absolute right-2 top-1/2 -translate-y-1/2 text-cool pointer-events-none" />
          </div>
        </div>

        <!-- Recipient -->
        <div class="flex flex-col gap-3">
          <label for="transfer-recipient-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">Recipient Address</label>
          <input
            id="transfer-recipient-input"
            v-model.trim="recipient"
            placeholder="0x…"
            spellcheck="false"
            autocomplete="off"
            :disabled="isProcessing"
            data-testid="transfer-recipient-input"
            class="w-full bg-transparent border-0 border-b border-haze dark:border-white/10
                   font-mono text-base text-midnight dark:text-white py-3 px-1
                   placeholder:text-cool/40 focus:outline-none focus:border-gold dark:focus:border-signal
                   transition-colors disabled:opacity-50"
          />
          <!-- Simulation readout -->
          <div
            v-if="simState.kind !== 'idle'"
            :class="[
              'flex items-start gap-2 text-xs font-sans leading-relaxed',
              simState.kind === 'ok' ? 'text-positive' : simState.kind === 'blocked' ? 'text-negative' : 'text-cool',
            ]"
            data-testid="transfer-sim-readout"
          >
            <Loader2 v-if="simState.kind === 'checking'" :size="13" class="animate-spin mt-0.5 flex-shrink-0" />
            <UserCheck v-else-if="simState.kind === 'ok'" :size="13" class="mt-0.5 flex-shrink-0" />
            <UserX v-else :size="13" class="mt-0.5 flex-shrink-0" />
            <span>
              <template v-if="simState.kind === 'checking'">Checking recipient KYC…</template>
              <template v-else-if="simState.kind === 'ok'">{{ simState.message }}</template>
              <template v-else>{{ simState.reason }}</template>
            </span>
          </div>
        </div>

        <!-- Amount -->
        <div class="flex flex-col gap-3">
          <label for="transfer-amount-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">Amount (shares)</label>
          <div class="flex items-end gap-2 border-b border-haze dark:border-white/10 pb-2 transition-colors focus-within:border-gold dark:focus-within:border-signal">
            <span aria-hidden="true" class="font-accent italic text-3xl md:text-4xl text-cool pb-0.5 leading-none">#</span>
            <input
              id="transfer-amount-input"
              v-model="amount"
              placeholder="0.00"
              inputmode="decimal"
              aria-label="Share amount"
              :disabled="isProcessing"
              data-testid="transfer-amount-input"
              class="w-full bg-transparent border-0 font-accent italic
                     text-4xl md:text-5xl text-midnight dark:text-white tabular-nums tracking-tight
                     placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none disabled:opacity-50"
            />
          </div>
        </div>

        <!-- Privacy note -->
        <div class="rounded-lg p-4 border border-compute/20 dark:border-signal/20 bg-compute/5 dark:bg-signal/5 flex items-start gap-3">
          <ShieldCheck :size="16" :stroke-width="1.8" class="text-compute dark:text-signal mt-0.5 flex-shrink-0" />
          <p class="font-sans text-[11px] text-cool leading-relaxed">
            Your post-transfer balance is decryptable only by this session's ephemeral EOA. The
            recipient still sees a kernel-granted handle — they'll re-grant their own ephemeral
            EOA on first decrypt.
          </p>
        </div>

        <!-- CTA -->
        <button
          type="button"
          @click="handleTransfer"
          :disabled="!canSubmit"
          data-testid="transfer-cta"
          class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                 flex items-center justify-center gap-2.5 cursor-pointer
                 transition-all duration-300 hover:-translate-y-0.5"
        >
          <Loader2 v-if="isProcessing" :size="16" class="animate-spin" />
          <Send v-else :size="16" :stroke-width="2" />
          <span class="uppercase tracking-[0.18em]">
            {{ isProcessing ? 'Encrypting & sending…' : 'Encrypt & Send' }}
          </span>
          <ArrowRight v-if="!isProcessing" :size="16" :stroke-width="2" />
        </button>

        <!-- Blocked hint -->
        <div
          v-if="simState.kind === 'blocked' && recipientAddressValid"
          class="rounded-lg p-4 border border-negative/25 bg-negative/5 flex items-start gap-3"
        >
          <AlertTriangle :size="16" :stroke-width="1.8" class="text-negative mt-0.5 flex-shrink-0" />
          <p class="font-sans text-[11px] text-cool leading-relaxed">
            Signing is disabled until the simulation clears. Fix the issue above or pick a
            different recipient.
          </p>
        </div>
      </div>
    </section>
    </template>
  </div>
</template>
