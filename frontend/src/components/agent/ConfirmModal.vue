<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ShieldCheck, Lock, X, Loader2, AlertTriangle, ExternalLink, ArrowRight, Send } from 'lucide-vue-next'
import {
  agentToolsApi,
  checkoutAgentApi,
  type ActionDescriptor,
  type CreateCheckoutActionPayload,
} from '@/services/api'
import CreateCheckoutSuccessCard from '@/components/agent/CreateCheckoutSuccessCard.vue'

const router = useRouter()

/**
 * Wave 4 P2 — per-action confirmation modal with cleartext preview.
 *
 * Backend mints an ActionDescriptor + confirm token; this component
 * renders the cleartext preview and runs the SDK call once the user
 * authorizes. The FHE encryption + UserOp signing both happen inside
 * this modal — backend never touches plaintext.
 *
 * For Wave 4 the on-chain SDK call is delegated to the page that already
 * owns the kernel (the agent surface today does not own kernel state).
 * Pattern: the modal emits `confirm` with the ActionDescriptor; parent
 * runs the SDK call and posts back the result via `complete` callback.
 *
 * The Wave 5 swap point is documented in ADR-6 §"On-chain ceremony
 * delegation": the modal will own the kernel directly when the agent
 * surface gains its own kernel context.
 */

const props = defineProps<{
  action: ActionDescriptor | null
  /** Optional override — defaults to the global ZeroDev kernel signer. */
  signerHint?: 'session' | 'master'
}>()

const emit = defineEmits<{
  /** User authorized — parent runs the SDK call + on success posts to commit. */
  confirm: [action: ActionDescriptor]
  /** User dismissed. */
  cancel: [action: ActionDescriptor]
  /** Stream completed (success or fail). Passes the txHash + commit result. */
  complete: [
    payload: {
      action: ActionDescriptor
      ok: boolean
      txHash?: string | null
      error?: string
    },
  ]
}>()

const isOpen = computed(() => props.action !== null)
const status = ref<
  'idle' | 'awaiting' | 'submitting' | 'committing' | 'success' | 'deferred' | 'error'
>('idle')
const txHash = ref<string | null>(null)
const errorMsg = ref<string | null>(null)
// Wave 4 §5 Path C — create_checkout commit returns a buyer URL
// (NOT a tx hash). When the success state renders for this kind, the
// success card surfaces this URL with Copy + Open affordances.
const checkoutResult = ref<{
  sessionId: string
  url: string
  fragmentKey: string
  expiresAt: string
} | null>(null)
const deferredRedirectTo = ref<string | null>(null)
const deferredReason = ref<string | null>(null)
// Q6 (i) — when the user has linked Telegram + the propose-buy call
// minted an OpenClaw intent that was delivered to the bot, the
// dashboard yields to Telegram by default: the Authorize button is
// hidden + the modal shows a "Waiting for Telegram confirmation…" panel
// instead. The user can override with the "Use dashboard instead"
// escape hatch (Telegram outage / impatient operator) — flipping this
// to `true` reveals the standard Authorize CTA without affecting the
// SSE auto-fire path (which still fires if the Telegram confirm lands
// before the manual Authorize completes — the per-intent fire-lock in
// AgentPage.tryAcquireFireLock dedupes the on-chain leg).
const useDashboardFallback = ref(false)

watch(
  () => props.action?.toolCallId,
  () => {
    // Reset on every new action.
    status.value = 'idle'
    txHash.value = null
    errorMsg.value = null
    useDashboardFallback.value = false
    checkoutResult.value = null
  },
)

const isExpired = computed(() => {
  if (!props.action) return false
  return Math.floor(Date.now() / 1000) > props.action.expiresAtSec
})

/**
 * Q6 (i) — the propose-buy use-case stamps `preview.openClawIntentId`
 * iff the user has an active Telegram link AND the mint-and-deliver
 * use-case posted the intent to the bot worker successfully. Treat
 * that as the "linked & Telegram is the canonical surface" signal.
 *
 * Wave 4 P4 already wires the SSE `intent_confirmed` event to auto-
 * fire the runner from `AgentPage.tryAcquireFireLock`, so the
 * dashboard's role here is to (a) NOT distract the user with an
 * Authorize CTA they shouldn't need to click, and (b) provide an
 * escape hatch so a Telegram outage / impatient operator can still
 * complete the action manually.
 */
const isTelegramLinked = computed(() => {
  if (!props.action) return false
  // Third-pass review (CodeReviewer MED-5): `openClawIntentId` is declared
  // only on `BuyActionDescriptor.preview`. Reading it from any other kind
  // is `undefined` today, but a future descriptor that adds the field
  // (e.g. propose_distribute_yield gaining a Telegram-confirm path)
  // would silently activate the "Confirm in Telegram" UI without the
  // SSE auto-fire wiring being plumbed in. Narrow the check to `buy` so
  // future descriptor additions are an opt-in via this gate.
  if (props.action.kind !== 'buy') return false
  const id = props.action.preview.openClawIntentId
  return typeof id === 'string' && id.length > 0
})

/**
 * When true, the modal renders the new "Waiting for Telegram"
 * pending panel + hides the Authorize CTA. Active only at idle (i.e.
 * before any submission); once SSE auto-fire flips the modal to
 * `awaiting`/`submitting`/`committing` the standard progression
 * surfaces take over.
 *
 * Known rare edge case (deferred to Wave 5): if propose-buy B is
 * stacked while A's runner is still in flight and the user confirms B
 * in Telegram before A completes, AgentPage's SSE handler reads the
 * stale `activeAction` (= A) at confirm-time, the `intent_confirmed`
 * event for B is dropped, and after A completes + the H-1 advance
 * lands B as the new activeAction, this panel renders for an intent
 * that's already 'confirmed' on the backend. The "Use dashboard
 * instead" escape hatch always works as a manual recovery; Wave 5
 * adds an intent-status lookup on activeAction change to auto-replay
 * the missed confirmation.
 */
const showTelegramPending = computed(() => {
  if (!isTelegramLinked.value) return false
  if (useDashboardFallback.value) return false
  return status.value === 'idle'
})

function close(): void {
  if (props.action) emit('cancel', props.action)
}

/**
 * Detect the insufficient-mhUSDC error path so the modal can swap
 * its primary CTA from "retry the same authorize" (which would just
 * fail again the same way) to "wrap mhUSDC on /cash" (the actionable
 * next step). Pattern-match on the runner's known error string from
 * `useAgentActionRunner.runBuy` — the only error today that ships
 * with that exact prefix. Other error types (NAV unavailable,
 * expired, kernel deploy fail) keep the retry-via-Authorize CTA.
 */
const isInsufficientBalanceError = computed(() => {
  if (status.value !== 'error') return false
  return /Insufficient mhUSDC balance/i.test(errorMsg.value ?? '')
})

/**
 * "Wrap mhUSDC" CTA on the insufficient-balance error state.
 * Dismisses the modal AND navigates to /cash so the user can wrap
 * USDC into mhUSDC. The propose-action is consumed (modal close
 * removes it from the pending queue); the user is expected to come
 * back to /agent with a balance and re-prompt the buy. Wave 5 may
 * re-issue the propose automatically post-wrap, but today the
 * flow is "navigate, wrap, return".
 */
function goToCash(): void {
  if (props.action) emit('cancel', props.action)
  router.push('/cash')
}

/**
 * Q6 (i) escape hatch — reveal the standard Authorize CTA so the user
 * can complete the action from the dashboard even when linked. SSE
 * auto-fire is left wired; if both paths race, the per-intent fire-
 * lock dedupes the on-chain leg.
 */
function useDashboard(): void {
  useDashboardFallback.value = true
}

async function authorize(): Promise<void> {
  if (!props.action) return
  if (isExpired.value) {
    errorMsg.value = 'This action has expired. Ask the agent to propose it again.'
    status.value = 'error'
    return
  }
  status.value = 'awaiting'
  emit('confirm', props.action)
}

/**
 * Public method — parent calls this after the SDK + kernel finishes
 * to surface the success/failure state inside the modal. Then commit
 * the audit-log entry server-side.
 *
 * Three-way result per H1 fix:
 *   - `ok: true` → on-chain tx settled (or pause idempotent), commit fires.
 *   - `ok: 'deferred'` → action requires follow-up on another page.
 *     Commit MUST NOT fire — audit row would record a permit_granted
 *     for an action that hasn't happened yet.
 *   - `ok: false` → submission failed; surface error.
 */
async function reportResult(
  payload:
    | { ok: true; txHash?: string | null }
    | { ok: 'deferred'; redirectTo: string; reason: string }
    | { ok: false; error: string },
): Promise<void> {
  if (!props.action) return
  if (payload.ok === false) {
    errorMsg.value = payload.error ?? 'Submission failed.'
    status.value = 'error'
    emit('complete', { action: props.action, ok: false, error: errorMsg.value })
    return
  }
  if (payload.ok === 'deferred') {
    deferredRedirectTo.value = payload.redirectTo
    deferredReason.value = payload.reason
    status.value = 'deferred'
    emit('complete', { action: props.action, ok: false, error: 'deferred' })
    return
  }
  txHash.value = payload.txHash ?? null
  status.value = 'committing'
  try {
    if (props.action.kind === 'create_checkout') {
      // Wave 4 §5 Path C — dedicated commit route returns the buyer URL
      // (the generic /tools/commit only writes audit). Backend mints the
      // session server-side because the AES-256-GCM key + fragment surface
      // are server primitives.
      const result = await checkoutAgentApi.commitCreateCheckout({
        surface: 'havenbot',
        confirmToken: props.action.confirmTokenId,
        actionPayload: extractActionPayload(props.action),
      })
      checkoutResult.value = result.session
      status.value = 'success'
      emit('complete', { action: props.action, ok: true, txHash: null })
      return
    }
    // Closes the propose → confirm → commit loop.
    await agentToolsApi.commit({
      surface: 'havenbot',
      actionKind: actionKind(props.action),
      actionPayload: extractActionPayload(props.action),
      confirmToken: props.action.confirmTokenId,
      txHash: payload.txHash ?? null,
    })
    status.value = 'success'
    emit('complete', { action: props.action, ok: true, txHash: payload.txHash ?? null })
  } catch (err) {
    errorMsg.value =
      err instanceof Error
        ? `Audit commit failed: ${err.message}`
        : 'Audit commit failed.'
    status.value = 'error'
    emit('complete', { action: props.action, ok: false, error: errorMsg.value })
  }
}

defineExpose({ reportResult, setSubmitting: () => (status.value = 'submitting') })

function actionKind(a: ActionDescriptor): 'permit_grant' | 'tier_transition' {
  return a.kind === 'set_policy' ? 'tier_transition' : 'permit_grant'
}

/**
 * Mirror of the backend's actionPayload shape. Must match the
 * propose-tool use case's payload exactly so the action-hash equality
 * check inside ConfirmTokenService.consume succeeds.
 */
function extractActionPayload(a: ActionDescriptor): Record<string, unknown> {
  switch (a.kind) {
    case 'buy':
      // navAt is REQUIRED here — backend hashes it into the action
      // payload at propose time. A null/missing value silently breaks
      // every commit (ConfirmTokenService 403). The descriptor
      // contract guarantees navAt is always populated.
      return {
        action: 'buy',
        tokenAddress: a.preview.tokenAddress,
        shares: a.preview.shares,
        maxSharesHint: a.preview.maxSharesHint,
        navUsd6: a.preview.navUsd6,
        navAt: a.preview.navAt,
      }
    case 'claim':
      return {
        action: 'claim',
        yieldRecordId: a.preview.yieldRecordId,
        onChainEscrowId: a.preview.onChainEscrowId,
        tokenAddress: a.preview.tokenAddress,
        distributionId: a.preview.distributionId,
      }
    case 'rebalance':
      return {
        action: 'rebalance',
        legs: a.preview.legs as unknown[],
      }
    case 'set_policy':
      return {
        action: 'set_policy',
        surface: a.preview.surface,
        targetTier: a.preview.targetTier,
      }
    case 'pause':
      return { action: 'pause' }
    case 'create_checkout': {
      // Mirror the propose-create-checkout actionPayload byte-for-byte.
      // The backend's commit hash-equality check refuses anything else.
      // The local `payload` variable is typed via the imported
      // `CreateCheckoutActionPayload` so a future field rename breaks
      // compile-time, not runtime as a 403 hash mismatch (third-pass
      // review CodeReviewer LOW-3 promoted). The cast at return narrows
      // from the typed shape to the function's wire-shape contract.
      const payload: CreateCheckoutActionPayload = {
        tool: 'muhaven_propose_create_checkout',
        action: 'create_checkout',
        tokenAddress: a.preview.tokenAddress as string,
        amountUsd6: a.preview.amountUsd6 as string,
        memo: (a.preview.memo as string | null | undefined) ?? null,
        successUrl: (a.preview.successUrl as string | null | undefined) ?? null,
        cancelUrl: (a.preview.cancelUrl as string | null | undefined) ?? null,
        issuerAddress: a.preview.issuerAddress as string,
        requestedAtSec: a.preview.requestedAtSec as number,
      }
      return payload as unknown as Record<string, unknown>
    }
    case 'unpause_token':
      // Mirror propose-unpause-token.use-case.ts:181 actionPayload
      // byte-for-byte. Order matches the backend object-literal so a
      // future field reorder doesn't drift the hash check. R-3
      // mitigation: requestedAtSec + tool are pinned and replayed.
      return {
        tool: 'muhaven_propose_unpause_token',
        action: 'unpause_token',
        tokenAddress: a.preview.tokenAddress as string,
        initialNavUsd6: a.preview.initialNavUsd6 as string,
        issuerOracleAddress: a.preview.issuerOracleAddress as string,
        tokenRegistryAddress: a.preview.tokenRegistryAddress as string,
        navPublishTxHash: a.preview.navPublishTxHash as string,
        requestedAtSec: a.preview.requestedAtSec as number,
      }
    case 'kyc_add':
      // Mirror propose-kyc-add.use-case.ts:112 actionPayload byte-for-byte.
      // M-2 (2026-05-19 self-review): `kycTier` is coerced via Number()
      // to guard against an SSE drift sending a string "1" / "2".
      // stableStringify on the backend hashes `2` as a number; a string
      // "2" would hash differently and 403 every commit. Cheap belt-
      // and-suspenders since the backend zod schema enforces number.
      return {
        tool: 'muhaven_propose_kyc_add',
        action: 'kyc_add',
        tokenAddress: a.preview.tokenAddress as string,
        investorAddress: a.preview.investorAddress as string,
        kycTier: Number(a.preview.kycTier) as 1 | 2,
        kycAdapterAddress: a.preview.kycAdapterAddress as string,
        requestedAtSec: a.preview.requestedAtSec as number,
      }
    case 'kyc_remove':
      // Mirror propose-kyc-remove.use-case.ts:97 actionPayload byte-for-byte.
      return {
        tool: 'muhaven_propose_kyc_remove',
        action: 'kyc_remove',
        tokenAddress: a.preview.tokenAddress as string,
        investorAddress: a.preview.investorAddress as string,
        kycAdapterAddress: a.preview.kycAdapterAddress as string,
        requestedAtSec: a.preview.requestedAtSec as number,
      }
    default:
      return {}
  }
}

const previewRows = computed(() => {
  if (!props.action) return []
  switch (props.action.kind) {
    case 'buy':
      return [
        { label: 'Token', value: `${props.action.preview.tokenSymbol}` },
        { label: 'Shares', value: String(props.action.preview.shares) },
        { label: 'NAV', value: displayUsd(String(props.action.preview.navUsd6)) },
        {
          label: 'Estimated total',
          value: displayUsd(String(props.action.preview.estimatedTotalUsd6)),
        },
      ]
    case 'claim':
      return [
        { label: 'Epoch', value: String(props.action.preview.distributionId) },
        { label: 'Escrow ID', value: String(props.action.preview.onChainEscrowId ?? '—') },
      ]
    case 'rebalance':
      return [
        {
          label: 'Legs',
          value: `${(props.action.preview.legs as unknown[] | undefined)?.length ?? 0}`,
        },
      ]
    case 'set_policy':
      return [
        { label: 'Surface', value: String(props.action.preview.surface) },
        { label: 'Target tier', value: String(props.action.preview.targetTier) },
      ]
    case 'pause':
      return [
        {
          label: 'Surface',
          value: String(props.action.preview.surface ?? 'all surfaces'),
        },
      ]
    case 'create_checkout':
      return [
        { label: 'Token', value: `${props.action.preview.tokenSymbol}` },
        { label: 'Amount', value: displayUsd(String(props.action.preview.amountUsd6)) },
        ...(props.action.preview.memo
          ? [{ label: 'Memo', value: String(props.action.preview.memo) }]
          : []),
      ]
    case 'unpause_token':
      // P7 — Design A · PREVENTION shape (2026-05-17). Backend has
      // already published the initial NAV server-side; the kernel only
      // signs setPaused(false). Surface the initial NAV + the
      // NAV-publish tx hash so the issuer sees provenance, not just
      // "Authorize" with no detail.
      return [
        { label: 'Token', value: `${props.action.preview.tokenSymbol}` },
        { label: 'Initial NAV', value: displayUsd(String(props.action.preview.initialNavUsd6)) },
        { label: 'Action', value: 'Set paused → false' },
        { label: 'NAV tx', value: shortTx(String(props.action.preview.navPublishTxHash)) },
      ]
    case 'kyc_add':
      return [
        { label: 'Token', value: `${props.action.preview.tokenSymbol}` },
        { label: 'Investor', value: shortAddr(String(props.action.preview.investorAddress)) },
        {
          label: 'KYC tier',
          value: props.action.preview.kycTier === 2
            ? '2 — accredited (2 txs)'
            : '1 — retail (1 tx)',
        },
      ]
    case 'kyc_remove':
      return [
        { label: 'Token', value: `${props.action.preview.tokenSymbol}` },
        { label: 'Investor', value: shortAddr(String(props.action.preview.investorAddress)) },
        { label: 'Action', value: 'Remove from whitelist' },
      ]
    default:
      return []
  }
})

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr || '—'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function shortTx(hash: string): string {
  if (!hash || hash.length < 12) return hash || '—'
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

function displayUsd(usd6: string): string {
  try {
    const v = BigInt(usd6)
    const whole = v / 1_000_000n
    const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
    return frac ? `$${whole.toString()}.${frac}` : `$${whole.toString()}`
  } catch {
    return `$${usd6}`
  }
}

const arbiscanUrl = computed(() =>
  txHash.value ? `https://sepolia.arbiscan.io/tx/${txHash.value}` : null,
)
</script>

<template>
  <div
    v-if="isOpen && action"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-modal-title"
    data-testid="agent-confirm-modal"
    :data-status="status"
    class="fixed inset-0 z-50 flex items-center justify-center px-4"
  >
    <!-- Backdrop -->
    <div
      class="absolute inset-0 bg-midnight/70 backdrop-blur-sm"
      @click="status === 'idle' || status === 'error' ? close() : null"
      aria-hidden="true"
    />

    <!-- Modal -->
    <div
      class="relative w-full max-w-md rounded-2xl
             bg-white dark:bg-[#171717]
             border border-haze dark:border-white/10
             shadow-2xl overflow-hidden"
    >
      <!-- Top accent -->
      <div
        aria-hidden="true"
        class="h-1.5 w-full bg-gradient-to-r from-compute via-gold to-signal opacity-80"
      />

      <button
        v-if="status === 'idle' || status === 'error' || status === 'deferred'"
        type="button"
        @click="close"
        aria-label="Cancel"
        class="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center
               text-cool hover:bg-mist dark:hover:bg-[#1f1e1e] transition-colors cursor-pointer"
      >
        <X :size="16" :stroke-width="2" />
      </button>

      <div class="p-6 md:p-7">
        <!-- Header -->
        <div class="flex items-center gap-3 mb-1.5">
          <div
            class="w-9 h-9 rounded-xl bg-gold/10 dark:bg-signal/10
                   border border-gold/25 dark:border-signal/25
                   flex items-center justify-center flex-shrink-0"
          >
            <Lock :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" />
          </div>
          <h2
            id="confirm-modal-title"
            class="font-sans font-semibold text-lg text-midnight dark:text-white"
          >
            Confirm with passkey
          </h2>
        </div>

        <p class="font-sans text-sm text-cool mb-5">
          {{ action.summary }}
        </p>

        <!-- Preview rows (cleartext only — encrypted handles never shown) -->
        <dl
          class="rounded-xl border border-haze dark:border-white/10
                 bg-mist/40 dark:bg-[#0d0e10] overflow-hidden mb-5"
        >
          <div
            v-for="row in previewRows"
            :key="row.label"
            class="flex items-center justify-between px-4 py-3
                   border-b border-haze dark:border-white/5 last:border-b-0"
          >
            <dt class="font-sans text-[10px] uppercase tracking-[0.18em] text-cool font-semibold">
              {{ row.label }}
            </dt>
            <dd class="font-mono text-sm text-midnight dark:text-white truncate ml-3">
              {{ row.value }}
            </dd>
          </div>
        </dl>

        <!-- Privacy strip -->
        <div
          class="flex items-center gap-2 px-3 py-2 rounded-lg bg-mist/40 dark:bg-[#0d0e10]
                 border border-haze dark:border-white/5 mb-5"
        >
          <ShieldCheck :size="14" :stroke-width="1.8" class="text-compute dark:text-signal flex-shrink-0" />
          <p class="font-sans text-xs text-cool leading-relaxed">
            FHE-encrypted on Arbitrum Sepolia. Only your passkey can authorize this transaction.
          </p>
        </div>

        <!-- Q6 (i) — Telegram-linked pending state. Renders BEFORE the
             status surfaces so a freshly-mounted modal (status='idle')
             with an OpenClaw intent shows the waiting panel + escape
             hatch instead of jumping straight to the Authorize CTA. -->
        <div
          v-if="showTelegramPending"
          data-testid="agent-confirm-telegram-pending"
          class="flex items-start gap-3 px-4 py-3 rounded-xl
                 bg-compute/5 dark:bg-signal/5
                 border border-compute/20 dark:border-signal/20 mb-5"
        >
          <Send :size="16" :stroke-width="1.8" class="text-compute dark:text-signal flex-shrink-0 mt-0.5" />
          <div class="flex-1 min-w-0">
            <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
              Confirm in Telegram
            </p>
            <p class="font-sans text-xs text-cool leading-relaxed mt-1">
              We sent this confirmation to your linked Telegram. This tab
              will auto-fire on-chain the moment you confirm there — no
              need to tap Authorize here.
            </p>
            <button
              type="button"
              @click="useDashboard"
              data-testid="agent-confirm-use-dashboard-cta"
              class="inline-flex items-center gap-1 font-sans text-xs font-semibold
                     text-compute dark:text-signal mt-2 underline decoration-compute/40
                     dark:decoration-signal/40 hover:decoration-compute dark:hover:decoration-signal
                     transition cursor-pointer"
            >
              Use dashboard instead
              <ArrowRight :size="11" :stroke-width="2" />
            </button>
          </div>
        </div>

        <!-- Status surfaces -->
        <!-- Wave 4 §5 Path C — buyer URL surface for create_checkout. -->
        <CreateCheckoutSuccessCard
          v-if="status === 'success' && action?.kind === 'create_checkout' && checkoutResult"
          :session="checkoutResult"
          class="mb-5"
        />

        <div
          v-else-if="status === 'success'"
          class="flex items-start gap-3 px-4 py-3 rounded-xl bg-positive/10 border border-positive/25 mb-5"
        >
          <ShieldCheck :size="16" :stroke-width="1.8" class="text-positive flex-shrink-0 mt-0.5" />
          <div class="flex-1 min-w-0">
            <p class="font-sans text-sm font-semibold text-positive">Settled.</p>
            <a
              v-if="arbiscanUrl"
              :href="arbiscanUrl"
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1 font-mono text-xs text-cool hover:text-compute mt-1 underline decoration-cool/40"
            >
              View on Arbiscan <ExternalLink :size="11" :stroke-width="1.8" />
            </a>
          </div>
        </div>

        <div
          v-else-if="status === 'deferred' && deferredRedirectTo"
          class="flex items-start gap-3 px-4 py-3 rounded-xl bg-mist/40 dark:bg-[#0d0e10] border border-haze dark:border-white/10 mb-5"
        >
          <ExternalLink
            :size="16"
            :stroke-width="1.8"
            class="text-compute dark:text-signal flex-shrink-0 mt-0.5"
          />
          <div class="flex-1 min-w-0">
            <p class="font-sans text-sm text-midnight dark:text-white leading-relaxed">
              {{ deferredReason ?? 'Continue this action on the next page.' }}
            </p>
            <a
              :href="deferredRedirectTo"
              class="inline-flex items-center gap-1 font-sans text-xs text-compute dark:text-signal mt-1.5 underline decoration-compute/40 dark:decoration-signal/40"
            >
              Continue on {{ deferredRedirectTo }}
              <ExternalLink :size="11" :stroke-width="1.8" />
            </a>
          </div>
        </div>

        <div
          v-else-if="status === 'error'"
          class="flex items-start gap-3 px-4 py-3 rounded-xl bg-negative/10 border border-negative/25 mb-5"
        >
          <AlertTriangle
            :size="16"
            :stroke-width="1.8"
            class="text-negative flex-shrink-0 mt-0.5"
          />
          <p class="font-sans text-sm text-negative leading-relaxed">
            {{ errorMsg ?? 'Authorization failed.' }}
          </p>
        </div>

        <!-- CTAs -->
        <div class="flex items-center gap-3">
          <button
            v-if="status !== 'success'"
            type="button"
            @click="close"
            data-testid="agent-confirm-cancel-cta"
            class="flex-1 py-3 px-4 rounded-xl font-sans text-sm font-medium
                   border border-haze dark:border-white/10
                   bg-white dark:bg-[#1f1e1e]
                   hover:bg-mist dark:hover:bg-[#252323]
                   text-midnight dark:text-white
                   transition-colors cursor-pointer"
            :disabled="status === 'awaiting' || status === 'submitting' || status === 'committing'"
          >
            {{
              status === 'error'
                ? 'Close'
                : status === 'deferred'
                  ? 'Done'
                  : 'Cancel'
            }}
          </button>
          <!-- Q6 (i) — passive "Waiting" pill replaces the Authorize CTA
               when the user is Telegram-linked + hasn't tapped "Use
               dashboard instead". Mirrors the awaiting/submitting/
               committing pill below for visual continuity. -->
          <div
            v-if="showTelegramPending"
            data-testid="agent-confirm-telegram-waiting-pill"
            class="flex-1 py-3 px-4 rounded-xl font-sans text-sm
                   bg-compute/10 dark:bg-signal/10
                   border border-compute/25 dark:border-signal/25
                   text-midnight dark:text-white
                   flex items-center justify-center gap-2"
          >
            <Loader2
              :size="14"
              :stroke-width="2"
              class="animate-spin text-compute dark:text-signal"
            />
            <span>Waiting for Telegram…</span>
          </div>
          <button
            v-else-if="status === 'idle' || (status === 'error' && !isInsufficientBalanceError)"
            type="button"
            @click="authorize"
            data-testid="agent-confirm-authorize-cta"
            class="btn-gold-sweep flex-1 py-3 px-4 rounded-xl font-sans text-sm font-semibold
                   flex items-center justify-center gap-2 cursor-pointer
                   transition-transform duration-150 active:scale-95"
            :disabled="isExpired"
          >
            <Lock :size="14" :stroke-width="2" />
            <span>{{ isExpired ? 'Expired' : 'Authorize' }}</span>
          </button>
          <!-- Insufficient-balance specialised CTA — replaces the retry
               Authorize button so the user isn't stuck clicking the
               same "Authorize" that just refused. Navigates straight
               to /cash to wrap USDC. -->
          <button
            v-else-if="status === 'error' && isInsufficientBalanceError"
            type="button"
            @click="goToCash"
            data-testid="agent-confirm-wrap-cta"
            class="btn-gold-sweep flex-1 py-3 px-4 rounded-xl font-sans text-sm font-semibold
                   flex items-center justify-center gap-2 cursor-pointer
                   transition-transform duration-150 active:scale-95"
          >
            <ArrowRight :size="14" :stroke-width="2" />
            <span>Wrap mhUSDC</span>
          </button>
          <div
            v-else-if="status === 'awaiting' || status === 'submitting' || status === 'committing'"
            class="flex-1 py-3 px-4 rounded-xl font-sans text-sm
                   bg-mist dark:bg-[#0d0e10]
                   border border-haze dark:border-white/10
                   text-midnight dark:text-white
                   flex items-center justify-center gap-2"
          >
            <Loader2
              :size="14"
              :stroke-width="2"
              class="animate-spin text-compute dark:text-signal"
            />
            <span>{{
              status === 'awaiting'
                ? 'Waiting for passkey…'
                : status === 'submitting'
                  ? 'Submitting…'
                  : 'Recording audit…'
            }}</span>
          </div>
          <button
            v-if="status === 'success'"
            type="button"
            @click="close"
            class="btn-gold-sweep flex-1 py-3 px-4 rounded-xl font-sans text-sm font-semibold
                   flex items-center justify-center gap-2 cursor-pointer"
          >
            <ShieldCheck :size="14" :stroke-width="2" />
            <span>Done</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
