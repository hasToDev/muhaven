<script setup lang="ts">
/**
 * /agent/onboarding — Wave 4 P2 onboarding wizard.
 *
 * Three-step flow: passkey ready → KYC self-whitelist → first buy.
 * Designed for a <6-minute completion budget per the canonical Wave 4
 * onboarding target. Wealthfront-style limits paragraph + sealed-glass-
 * envelope copy land here so non-technical investors get the privacy
 * pitch on the rails of the same flow that mints their first position.
 *
 * The page is gate-friendly: each step inspects current account state
 * (passkey present, KYC whitelisted, holdings present) and can no-op
 * past completed steps. Returning to this page after completion lands
 * directly on the celebrate screen.
 */

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  ShieldCheck,
  Lock,
  Sparkles,
  Loader2,
  CheckCircle2,
  ArrowRight,
  Wallet,
  KeyRound,
  TrendingUp,
} from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { agentToolsApi, demoApi, type ActionDescriptor } from '@/services/api'
import { runAgentAction } from '@/composables/useAgentActionRunner'
import ConfirmModal from '@/components/agent/ConfirmModal.vue'
import { tokensApi } from '@/services/api'

interface OnboardingStep {
  key: 'passkey' | 'kyc' | 'first-buy'
  title: string
  description: string
}

const STEPS: OnboardingStep[] = [
  {
    key: 'passkey',
    title: 'Passkey ready',
    description:
      'Your passkey signs every action. ZeroDev binds it to a smart-account kernel — no seed phrases, recoverable from any device with your passkey.',
  },
  {
    key: 'kyc',
    title: 'KYC whitelist',
    description:
      'Confidential RWAs require a KYC attestation on the ERC-3643 registry. Your identity stays private; only an "is whitelisted" bit is read on every transfer.',
  },
  {
    key: 'first-buy',
    title: 'First position',
    description:
      'A small TBILL1 buy seals your portfolio. The amount + share count are FHE-encrypted on Arbitrum Sepolia — only you and your authorized agents can decrypt.',
  },
]

const FIRST_BUY_AMOUNT = '50' // 50 shares — modest first position

const ONBOARDING_COMPLETE_KEY = 'muhaven:onboarding:complete'
function persistOnboardingComplete(): void {
  try {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, '1')
  } catch {
    /* localStorage may be disabled — non-fatal */
  }
}
function readOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === '1'
  } catch {
    return false
  }
}

const router = useRouter()
const authStore = useAuthStore()

const currentStep = ref<0 | 1 | 2 | 3>(0) // 3 = celebrate
const passkeyReady = ref(false)
const kycReady = ref(false)
const firstBuyDone = ref(false)
const inflight = ref<'kyc' | 'buy' | null>(null)
const errorMsg = ref<string | null>(null)

// First-buy proposal + ConfirmModal wiring (mirrors AgentPage).
const confirmModalRef = ref<InstanceType<typeof ConfirmModal> | null>(null)
const activeAction = ref<ActionDescriptor | null>(null)

const targetTokenAddress = ref<string | null>(null)
const targetTokenSymbol = ref<string>('TBILL1')

onMounted(async () => {
  // Step 1 — passkey ready. Auth-store carries the SIWE/passkey state
  // because the user landed here through the dashboard's auth flow.
  passkeyReady.value = authStore.isAuthenticated
  if (passkeyReady.value && currentStep.value === 0) currentStep.value = 1

  // H2 fix — restore prior onboarding completion. Either the
  // localStorage flag or a non-empty portfolio implies "done".
  const previouslyComplete = readOnboardingComplete()

  // Resolve the first-buy target — pick the first active TBILL token.
  try {
    const { tokens } = await tokensApi.getAll()
    const tbill = tokens.find(
      (t) => t.symbol.toUpperCase().includes('TBILL') && t.status === 'active',
    )
    if (tbill) {
      targetTokenAddress.value = tbill.address
      targetTokenSymbol.value = tbill.symbol
    }
  } catch (err) {
    console.warn('[Onboarding] tokens.getAll failed', err)
  }

  // Probe the user's portfolio — if any positions exist, skip steps 2+3
  // so a returning user lands directly on the celebrate screen instead
  // of accidentally double-running the first-buy ceremony.
  if (passkeyReady.value) {
    try {
      const summary = (await agentToolsApi.portfolioSummary({})) as {
        totalPositions?: number
      }
      if ((summary.totalPositions ?? 0) > 0) {
        kycReady.value = true // implied — KYC must have passed for any holding to exist
        firstBuyDone.value = true
        currentStep.value = 3
        if (!previouslyComplete) persistOnboardingComplete()
        return
      }
    } catch (err) {
      console.warn('[Onboarding] portfolio probe failed', err)
    }
  }

  // No positions yet but the localStorage flag survives → reuse it.
  if (previouslyComplete && passkeyReady.value) {
    firstBuyDone.value = true
    kycReady.value = true
    currentStep.value = 3
  }
})

async function handleKyc(): Promise<void> {
  if (kycReady.value) return
  inflight.value = 'kyc'
  errorMsg.value = null
  try {
    const out = await demoApi.whitelistSelf()
    if (out.alreadyComplete || out.whitelisted) {
      kycReady.value = true
      currentStep.value = 2
      toast.success('KYC complete', {
        description: 'You are whitelisted on the ERC-3643 registry.',
      })
    } else {
      throw new Error('Whitelist did not complete — try again.')
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : 'KYC step failed.'
    toast.error('KYC step failed', { description: errorMsg.value })
  } finally {
    inflight.value = null
  }
}

async function handleFirstBuy(): Promise<void> {
  if (!targetTokenAddress.value) {
    errorMsg.value = 'No active TBILL token in this environment.'
    return
  }
  inflight.value = 'buy'
  errorMsg.value = null
  try {
    const descriptor = await agentToolsApi.proposeBuy({
      tokenAddress: targetTokenAddress.value,
      shares: FIRST_BUY_AMOUNT,
    })
    activeAction.value = descriptor
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : 'Could not draft first buy.'
    toast.error('Couldn\'t prepare first buy', { description: errorMsg.value })
  } finally {
    inflight.value = null
  }
}

async function onAuthorize(action: ActionDescriptor): Promise<void> {
  confirmModalRef.value?.setSubmitting()
  const result = await runAgentAction(action)
  await confirmModalRef.value?.reportResult(result)
  if (result.ok === true) {
    firstBuyDone.value = true
    currentStep.value = 3
    persistOnboardingComplete()
    toast.success('First position settled', {
      description: 'Your portfolio is encrypted and live.',
    })
  } else if (result.ok === 'deferred') {
    toast.info('Continue on the next page', { description: result.reason })
  }
}

function onConfirmComplete(payload: {
  action: ActionDescriptor
  ok: boolean
  txHash?: string | null
  error?: string
}): void {
  if (!payload.ok && payload.error !== 'deferred') {
    errorMsg.value = payload.error ?? 'Authorization failed.'
    activeAction.value = null
  }
  // On success: ConfirmModal stays in success state with "Done" CTA;
  // user closes it from there.
}

function onConfirmCancel(): void {
  activeAction.value = null
}

function gotoPortfolio(): void {
  void router.push('/portfolio')
}

const totalSteps = STEPS.length
const progressPercent = computed(() => {
  if (currentStep.value === 3) return 100
  return Math.round((currentStep.value / totalSteps) * 100)
})
</script>

<template>
  <div class="max-w-2xl mx-auto px-4 py-10 md:py-16">
    <Teleport to="body">
      <ConfirmModal
        ref="confirmModalRef"
        :action="activeAction"
        @confirm="onAuthorize"
        @cancel="onConfirmCancel"
        @complete="onConfirmComplete"
      />
    </Teleport>

    <!-- Hero -->
    <div class="text-center mb-10">
      <div
        class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full
               bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 mb-4"
      >
        <ShieldCheck :size="14" :stroke-width="1.8" class="text-compute dark:text-signal" />
        <span class="font-sans text-[10px] uppercase tracking-[0.22em] font-semibold text-compute dark:text-signal">
          Sealed-glass-envelope onboarding
        </span>
      </div>
      <h1
        class="font-display text-4xl md:text-5xl font-semibold text-midnight dark:text-white tracking-tight mb-3"
      >
        Three steps to your first encrypted position.
      </h1>
      <p class="font-sans text-base md:text-lg text-cool max-w-xl mx-auto leading-relaxed">
        Every balance, every yield, every threshold lives encrypted on Arbitrum Sepolia.
        Only your passkey unseals what you hold — not us, not the LLM, not the operator.
      </p>
    </div>

    <!-- Progress bar -->
    <div
      class="rounded-2xl border border-haze dark:border-white/10
             bg-white dark:bg-[#171717] overflow-hidden mb-8"
    >
      <div
        aria-hidden="true"
        class="h-1.5 bg-gradient-to-r from-compute via-gold to-signal opacity-80 transition-all duration-500"
        :style="{ width: `${progressPercent}%` }"
      />
      <div class="flex items-center justify-between px-5 py-3">
        <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
          Step {{ Math.min(currentStep + 1, totalSteps) }} of {{ totalSteps }}
        </span>
        <span class="font-mono text-xs text-compute dark:text-signal">{{ progressPercent }}%</span>
      </div>
    </div>

    <!-- Limits paragraph (Wealthfront-style) -->
    <div
      class="rounded-2xl bg-mist/40 dark:bg-[#0d0e10] border border-haze dark:border-white/5
             px-5 py-4 mb-8"
    >
      <p class="font-sans text-sm text-cool leading-relaxed">
        <strong class="text-midnight dark:text-white">During onboarding</strong>, your agent
        proposes — you sign every action with your passkey. Daily-spend caps,
        max-drawdown thresholds, and minimum-yield floors live encrypted on-chain via Fhenix
        FHE. The agent never sees the values; the policy gate compares encrypted handles to
        your encrypted thresholds and only emits a public boolean: pass or breach.
      </p>
    </div>

    <!-- Step cards -->
    <div class="space-y-5">
      <!-- Step 1 — Passkey ready -->
      <div
        :class="[
          'rounded-2xl border bg-white dark:bg-[#171717] overflow-hidden transition-all',
          passkeyReady ? 'border-positive/30' : 'border-haze dark:border-white/10',
          currentStep === 0 ? 'shadow-2xl' : '',
        ]"
      >
        <div class="flex items-start gap-4 p-5 md:p-6">
          <div
            :class="[
              'w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0',
              passkeyReady
                ? 'bg-positive/10 text-positive'
                : 'bg-gold/10 dark:bg-signal/10 text-compute dark:text-signal',
            ]"
          >
            <CheckCircle2 v-if="passkeyReady" :size="18" :stroke-width="1.8" />
            <KeyRound v-else :size="18" :stroke-width="1.8" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-3 mb-1">
              <h2 class="font-sans font-semibold text-base text-midnight dark:text-white">
                {{ STEPS[0].title }}
              </h2>
              <span
                v-if="passkeyReady"
                class="font-sans text-[9px] uppercase tracking-[0.2em] text-positive font-semibold"
              >
                Done
              </span>
            </div>
            <p class="font-sans text-sm text-cool leading-relaxed">
              {{ STEPS[0].description }}
            </p>
          </div>
        </div>
      </div>

      <!-- Step 2 — KYC whitelist -->
      <div
        :class="[
          'rounded-2xl border bg-white dark:bg-[#171717] overflow-hidden transition-all',
          kycReady ? 'border-positive/30' : 'border-haze dark:border-white/10',
          currentStep === 1 ? 'shadow-2xl' : '',
        ]"
      >
        <div class="p-5 md:p-6">
          <div class="flex items-start gap-4 mb-3">
            <div
              :class="[
                'w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0',
                kycReady
                  ? 'bg-positive/10 text-positive'
                  : 'bg-gold/10 dark:bg-signal/10 text-compute dark:text-signal',
              ]"
            >
              <CheckCircle2 v-if="kycReady" :size="18" :stroke-width="1.8" />
              <ShieldCheck v-else :size="18" :stroke-width="1.8" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-3 mb-1">
                <h2 class="font-sans font-semibold text-base text-midnight dark:text-white">
                  {{ STEPS[1].title }}
                </h2>
                <span
                  v-if="kycReady"
                  class="font-sans text-[9px] uppercase tracking-[0.2em] text-positive font-semibold"
                >
                  Done
                </span>
              </div>
              <p class="font-sans text-sm text-cool leading-relaxed">
                {{ STEPS[1].description }}
              </p>
            </div>
          </div>
          <button
            v-if="!kycReady && passkeyReady"
            type="button"
            @click="handleKyc"
            :disabled="inflight === 'kyc'"
            class="btn-gold-sweep w-full sm:w-auto py-3 px-6 rounded-xl
                   font-sans text-sm font-semibold cursor-pointer
                   inline-flex items-center justify-center gap-2"
          >
            <Loader2 v-if="inflight === 'kyc'" :size="14" :stroke-width="2" class="animate-spin" />
            <ShieldCheck v-else :size="14" :stroke-width="2" />
            <span>{{ inflight === 'kyc' ? 'Whitelisting…' : 'Whitelist me' }}</span>
          </button>
        </div>
      </div>

      <!-- Step 3 — First buy -->
      <div
        :class="[
          'rounded-2xl border bg-white dark:bg-[#171717] overflow-hidden transition-all',
          firstBuyDone ? 'border-positive/30' : 'border-haze dark:border-white/10',
          currentStep === 2 ? 'shadow-2xl' : '',
        ]"
      >
        <div class="p-5 md:p-6">
          <div class="flex items-start gap-4 mb-3">
            <div
              :class="[
                'w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0',
                firstBuyDone
                  ? 'bg-positive/10 text-positive'
                  : 'bg-gold/10 dark:bg-signal/10 text-compute dark:text-signal',
              ]"
            >
              <CheckCircle2 v-if="firstBuyDone" :size="18" :stroke-width="1.8" />
              <TrendingUp v-else :size="18" :stroke-width="1.8" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-3 mb-1">
                <h2 class="font-sans font-semibold text-base text-midnight dark:text-white">
                  {{ STEPS[2].title }}
                </h2>
                <span
                  v-if="firstBuyDone"
                  class="font-sans text-[9px] uppercase tracking-[0.2em] text-positive font-semibold"
                >
                  Done
                </span>
              </div>
              <p class="font-sans text-sm text-cool leading-relaxed">
                {{ STEPS[2].description }}
              </p>
              <!-- Prescribed onboarding amount — informational only, shown
                   while the first-buy step is still pending. Hidden on
                   the celebrate path so a returning investor with a
                   different (2 / 17 / etc.) position size doesn't read
                   "50 shares of TBILL1 — Done" as a claim about their
                   actual holding. -->
              <p
                v-if="targetTokenAddress && !firstBuyDone"
                class="mt-2 font-mono text-xs text-cool"
              >
                {{ FIRST_BUY_AMOUNT }} shares of {{ targetTokenSymbol }}
              </p>
            </div>
          </div>
          <button
            v-if="!firstBuyDone && kycReady"
            type="button"
            @click="handleFirstBuy"
            :disabled="inflight === 'buy' || !targetTokenAddress"
            class="btn-gold-sweep w-full sm:w-auto py-3 px-6 rounded-xl
                   font-sans text-sm font-semibold cursor-pointer
                   inline-flex items-center justify-center gap-2"
          >
            <Loader2 v-if="inflight === 'buy'" :size="14" :stroke-width="2" class="animate-spin" />
            <Lock v-else :size="14" :stroke-width="2" />
            <span>
              {{
                inflight === 'buy'
                  ? 'Drafting…'
                  : !targetTokenAddress
                    ? 'No token available'
                    : 'Buy first position'
              }}
            </span>
          </button>
        </div>
      </div>

      <!-- Celebrate -->
      <div
        v-if="currentStep === 3"
        class="rounded-2xl border border-positive/30 bg-positive/5 dark:bg-positive/10 p-6 md:p-7"
      >
        <div class="flex items-start gap-4">
          <div
            class="w-11 h-11 rounded-xl bg-positive/20 text-positive flex items-center justify-center flex-shrink-0"
          >
            <Sparkles :size="18" :stroke-width="1.8" />
          </div>
          <div class="flex-1">
            <h2 class="font-sans font-semibold text-base text-midnight dark:text-white mb-1">
              You're live.
            </h2>
            <p class="font-sans text-sm text-cool leading-relaxed mb-4">
              Your encrypted portfolio is settled on Arbitrum Sepolia. From here, your agent
              proposes — you authorize. Open the dashboard to watch yield accrue.
            </p>
            <button
              type="button"
              @click="gotoPortfolio"
              class="btn-gold-sweep py-3 px-6 rounded-xl font-sans text-sm font-semibold cursor-pointer
                     inline-flex items-center justify-center gap-2"
            >
              <Wallet :size="14" :stroke-width="2" />
              <span>Open portfolio</span>
              <ArrowRight :size="14" :stroke-width="2" />
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="errorMsg"
        class="rounded-xl border border-negative/25 bg-negative/10 px-4 py-3 mt-3"
      >
        <p class="font-sans text-sm text-negative leading-relaxed">{{ errorMsg }}</p>
      </div>
    </div>
  </div>
</template>
