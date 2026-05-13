<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { X, Copy, ExternalLink, AlertCircle, Loader2, Check, Link as LinkIcon } from 'lucide-vue-next'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { useAuthStore } from '@/stores/auth'
import { checkoutApi, type CreateCheckoutSessionResponse } from '@/services/api'
import MButton from '@/components/ui/MButton.vue'
import { useModalA11y } from '@/composables/useModalA11y'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', session: CreateCheckoutSessionResponse): void
}>()

const tokensStore = useIssuerTokensStore()
const authStore = useAuthStore()

const tokenAddress = ref<string>('')
const amountUsd = ref<string>('')
const memo = ref<string>('')
const successUrl = ref<string>('')
const cancelUrl = ref<string>('')
const submitting = ref(false)
const submitError = ref<string | null>(null)

// Modal a11y wiring (CRITICAL fixes from Accessibility-Auditor pass):
// ESC dismissal, focus trap on Tab, focus restoration on close. ESC is
// disabled while a submission is in flight so an accidental keypress
// doesn't drop the pending API call.
const rootRef = ref<HTMLElement | null>(null)
const disableEscape = computed(() => submitting.value)
useModalA11y({
  isOpen: toRef(props, 'open'),
  rootRef,
  onEscape: () => emit('close'),
  disableEscape,
})
const liveAnnouncement = ref<string>('')
const result = ref<CreateCheckoutSessionResponse | null>(null)
const copyState = ref<'idle' | 'copied'>('idle')
let copyTimer: ReturnType<typeof setTimeout> | null = null

onBeforeUnmount(() => {
  // Self-review: orphan-timer cleanup so a quick mount/unmount cycle
  // doesn't leave a setTimeout firing into a destroyed component
  // (Vue warns about the ref write; in production it's a memory leak).
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
})

const activeTokens = computed(() =>
  tokensStore.tokens.filter((t) => t.status === 'active'),
)

watch(
  () => props.open,
  (open) => {
    if (open) {
      // Default to the store's selected token if it's active, else the
      // first active token; explicitly EMPTY-string the field so the
      // <option value=""> placeholder renders for an issuer with no
      // active tokens yet.
      const selected = activeTokens.value.find(
        (t) => t.address === tokensStore.selectedAddress,
      )
      tokenAddress.value =
        selected?.address ?? activeTokens.value[0]?.address ?? ''
    } else {
      // Reset all fields on close so a re-open isn't pre-populated with
      // a stale submission.
      tokenAddress.value = ''
      amountUsd.value = ''
      memo.value = ''
      successUrl.value = ''
      cancelUrl.value = ''
      submitError.value = null
      result.value = null
    }
  },
)

/** Convert UI USD with optional 6dp to base units (BigInt-safe string). */
function usdToBaseUnits(input: string): string | null {
  const trimmed = input.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null
  const [whole, frac = ''] = trimmed.split('.')
  const padded = (frac + '000000').slice(0, 6)
  const out = (BigInt(whole || '0') * 1_000_000n + BigInt(padded || '0')).toString()
  if (out === '0') return null
  return out
}

const amountValid = computed(() => usdToBaseUnits(amountUsd.value) !== null)

const canSubmit = computed(
  () => !!tokenAddress.value && amountValid.value && !submitting.value,
)

async function handleSubmit() {
  submitError.value = null
  const amountUsd6 = usdToBaseUnits(amountUsd.value)
  if (!amountUsd6 || !tokenAddress.value) {
    submitError.value = 'Token + amount are required.'
    return
  }
  const token = activeTokens.value.find((t) => t.address === tokenAddress.value)
  if (!token) {
    submitError.value = 'Pick an active token.'
    return
  }
  submitting.value = true
  try {
    const res = await checkoutApi.createSession({
      metadata: {
        issuerAddress: authStore.walletAddress ?? '',
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        issuerLabel: null,
        description: memo.value.trim() || `${token.symbol} purchase`,
        successUrl: successUrl.value.trim() || null,
        cancelUrl: cancelUrl.value.trim() || null,
      },
      payload: {
        amountUsd6,
        ...(memo.value.trim() ? { memo: memo.value.trim() } : {}),
      },
    })
    result.value = res
    emit('created', res)
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : 'Create failed'
  } finally {
    submitting.value = false
  }
}

async function copyUrl() {
  if (!result.value) return
  try {
    await navigator.clipboard.writeText(result.value.url)
    copyState.value = 'copied'
    liveAnnouncement.value = 'Checkout URL copied to clipboard.'
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copyState.value = 'idle'
      liveAnnouncement.value = ''
    }, 1800)
  } catch {
    liveAnnouncement.value = 'Could not copy URL. Try selecting it manually.'
  }
}

function close() {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-midnight/40 backdrop-blur-sm"
        data-testid="checkout-link-modal"
        @click.self="submitting ? null : close()"
      >
        <Transition
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="opacity-0 translate-y-2"
          enter-to-class="opacity-100 translate-y-0"
        >
          <div
            v-if="open"
            ref="rootRef"
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkout-link-modal-title"
            class="w-full max-w-lg bg-white dark:bg-midnight-mid rounded-2xl shadow-2xl ring-1 ring-haze dark:ring-white/8 overflow-hidden"
          >
            <!-- aria-live region for copy + submit status (visually hidden) -->
            <span class="sr-only" aria-live="polite" aria-atomic="true">{{ liveAnnouncement }}</span>

            <!-- Header -->
            <div class="flex items-center justify-between px-6 py-5 border-b border-haze/70 dark:border-white/8">
              <div class="flex items-center gap-2.5">
                <span class="inline-flex w-8 h-8 rounded-lg bg-gold/10 ring-1 ring-gold/30 items-center justify-center">
                  <LinkIcon :size="16" class="text-compute dark:text-signal" />
                </span>
                <div>
                  <h2 id="checkout-link-modal-title" class="font-sans font-semibold text-base text-midnight dark:text-white">
                    {{ result ? 'Checkout link minted' : 'New checkout link' }}
                  </h2>
                  <p class="font-sans text-[11px] text-cool mt-0.5">
                    {{ result ? 'Share the URL ONCE — the fragment key cannot be recovered.' : 'Mint a buyer URL for a specific token + amount.' }}
                  </p>
                </div>
              </div>
              <button
                type="button"
                :disabled="submitting"
                class="p-1.5 text-cool hover:text-midnight dark:hover:text-white rounded-md hover:bg-mist/60 dark:hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Close dialog"
                @click="close"
              >
                <X :size="18" />
              </button>
            </div>

            <!-- Body — Form (idle) -->
            <div v-if="!result" class="p-6 space-y-5">
              <div v-if="activeTokens.length === 0" class="rounded-lg bg-mist/60 dark:bg-white/5 ring-1 ring-haze dark:ring-white/8 px-4 py-3 text-sm text-cool">
                You have no active tokens. <RouterLink to="/tokens" class="text-compute dark:text-signal underline-offset-2 hover:underline">Deploy or unpause a token</RouterLink> first.
              </div>
              <template v-else>
                <label class="block">
                  <span class="font-label text-[11px] tracking-[0.14em] uppercase text-cool font-semibold">Token</span>
                  <select
                    v-model="tokenAddress"
                    data-testid="checkout-link-token"
                    class="mt-1.5 w-full bg-white dark:bg-midnight px-3 py-2.5 rounded-md ring-1 ring-haze dark:ring-white/12 text-sm font-sans text-midnight dark:text-white"
                  >
                    <option
                      v-for="t in activeTokens"
                      :key="t.address"
                      :value="t.address"
                      class="bg-white dark:bg-midnight text-midnight dark:text-white"
                    >
                      {{ t.symbol }} — {{ t.name }}
                    </option>
                  </select>
                </label>

                <label class="block">
                  <span class="font-label text-[11px] tracking-[0.14em] uppercase text-cool font-semibold">Amount in mhUSDC</span>
                  <div class="mt-1.5 relative">
                    <input
                      v-model="amountUsd"
                      type="text"
                      inputmode="decimal"
                      placeholder="e.g. 5.00"
                      data-testid="checkout-link-amount"
                      class="w-full bg-white dark:bg-midnight pl-3 pr-14 py-2.5 rounded-md ring-1 ring-haze dark:ring-white/12 text-sm font-sans text-midnight dark:text-white tabular-nums focus:outline-none focus:ring-2 focus:ring-gold/60"
                    />
                    <span class="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] uppercase tracking-widest text-cool">USD</span>
                  </div>
                  <p v-if="amountUsd && !amountValid" class="mt-1 text-[11px] text-negative">
                    Amount must be a positive number with up to 6 decimals.
                  </p>
                </label>

                <label class="block">
                  <span class="font-label text-[11px] tracking-[0.14em] uppercase text-cool font-semibold">Memo <span class="font-sans normal-case tracking-normal text-cool/60 ml-1">(optional)</span></span>
                  <textarea
                    v-model="memo"
                    rows="2"
                    maxlength="280"
                    placeholder="What is this payment for?"
                    data-testid="checkout-link-memo"
                    aria-describedby="memo-counter"
                    class="mt-1.5 w-full bg-white dark:bg-midnight px-3 py-2.5 rounded-md ring-1 ring-haze dark:ring-white/12 text-sm font-sans text-midnight dark:text-white focus:outline-none focus:ring-2 focus:ring-gold/60"
                  />
                  <!-- Third-pass review (Frontend M1): inline character
                       counter so the user discovers the cap before
                       hitting it. Approaching cap (≥80%) tints amber;
                       at cap turns negative. -->
                  <span
                    id="memo-counter"
                    aria-live="polite"
                    :class="[
                      'mt-1 block text-[11px] tabular-nums text-right',
                      memo.length >= 280
                        ? 'text-negative'
                        : memo.length >= 224
                          ? 'text-gold'
                          : 'text-cool/70',
                    ]"
                  >{{ memo.length }} / 280</span>
                </label>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label class="block">
                    <span class="font-label text-[11px] tracking-[0.14em] uppercase text-cool font-semibold">Success URL <span class="font-sans normal-case tracking-normal text-cool/60">(optional)</span></span>
                    <input
                      v-model="successUrl"
                      type="url"
                      pattern="https://.+"
                      placeholder="https://issuer.example/thanks"
                      class="mt-1.5 w-full bg-white dark:bg-midnight px-3 py-2 rounded-md ring-1 ring-haze dark:ring-white/12 text-xs font-mono text-midnight dark:text-white focus:outline-none focus:ring-2 focus:ring-gold/60"
                    />
                    <!-- Third-pass review (Frontend M2): explicit https-
                         only hint so an http://example.com paste doesn't
                         bounce off the backend's 400 with no context. -->
                    <span class="mt-1 block text-[11px] text-cool/70">Public HTTPS only.</span>
                  </label>
                  <label class="block">
                    <span class="font-label text-[11px] tracking-[0.14em] uppercase text-cool font-semibold">Cancel URL <span class="font-sans normal-case tracking-normal text-cool/60">(optional)</span></span>
                    <input
                      v-model="cancelUrl"
                      type="url"
                      pattern="https://.+"
                      placeholder="https://issuer.example/cancel"
                      class="mt-1.5 w-full bg-white dark:bg-midnight px-3 py-2 rounded-md ring-1 ring-haze dark:ring-white/12 text-xs font-mono text-midnight dark:text-white focus:outline-none focus:ring-2 focus:ring-gold/60"
                    />
                    <span class="mt-1 block text-[11px] text-cool/70">Public HTTPS only.</span>
                  </label>
                </div>

                <div
                  v-if="submitError"
                  role="alert"
                  class="flex items-start gap-2 rounded-lg bg-negative/8 ring-1 ring-negative/30 px-3 py-2 text-xs text-negative"
                >
                  <AlertCircle :size="14" class="mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <span>{{ submitError }}</span>
                </div>
              </template>
            </div>

            <!-- Body — Success -->
            <div v-else class="p-6 space-y-4">
              <div class="rounded-lg bg-gold/10 ring-1 ring-gold/30 px-4 py-3">
                <p class="font-label text-[11px] tracking-[0.14em] uppercase text-compute dark:text-signal font-semibold">
                  Buyer URL · share once
                </p>
                <div class="mt-2 flex items-stretch gap-2">
                  <code class="flex-1 min-w-0 bg-white dark:bg-midnight rounded-md ring-1 ring-haze dark:ring-white/12 px-3 py-2 font-mono text-[11px] text-midnight dark:text-white break-all overflow-x-auto" data-testid="checkout-link-url">
                    {{ result.url }}
                  </code>
                </div>
                <p class="mt-2 text-[11px] text-cool leading-relaxed">
                  The URL fragment after <code class="font-mono text-cool/80">#k=</code> decrypts the amount on the buyer's device — we cannot recover it server-side. Save the link now.
                </p>
              </div>

              <div class="rounded-lg bg-mist/60 dark:bg-white/3 ring-1 ring-haze/70 dark:ring-white/8 px-4 py-3 text-xs font-sans text-cool flex items-start gap-2">
                <AlertCircle :size="14" class="mt-0.5 flex-shrink-0 text-gold" />
                <span>
                  Status: <strong class="font-semibold text-midnight dark:text-white capitalize">{{ result.status }}</strong> · expires <span class="font-mono">{{ new Date(result.expiresAt).toLocaleString() }}</span>
                </span>
              </div>
            </div>

            <!-- Footer -->
            <div class="flex items-center justify-end gap-2 px-6 py-4 border-t border-haze/70 dark:border-white/8 bg-mist/40 dark:bg-midnight/40">
              <template v-if="!result">
                <MButton variant="ghost" size="sm" @click="close">Cancel</MButton>
                <MButton
                  variant="primary"
                  size="sm"
                  :disabled="!canSubmit"
                  :loading="submitting"
                  data-testid="checkout-link-submit"
                  @click="handleSubmit"
                >
                  <Loader2 v-if="submitting" :size="14" class="animate-spin" />
                  <span v-else>Mint link</span>
                </MButton>
              </template>
              <template v-else>
                <MButton
                  variant="secondary"
                  size="sm"
                  data-testid="checkout-link-copy"
                  :aria-label="copyState === 'copied' ? 'Checkout URL copied' : 'Copy checkout URL'"
                  @click="copyUrl"
                >
                  <Check v-if="copyState === 'copied'" :size="14" class="text-positive" aria-hidden="true" />
                  <Copy v-else :size="14" aria-hidden="true" />
                  <span class="ml-1.5">{{ copyState === 'copied' ? 'Copied' : 'Copy URL' }}</span>
                </MButton>
                <a
                  :href="result.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="checkout-link-open"
                  class="inline-flex items-center gap-1.5 text-xs font-sans font-semibold text-compute dark:text-signal hover:underline px-3 py-2"
                >
                  Open
                  <ExternalLink :size="13" />
                </a>
                <MButton variant="primary" size="sm" @click="close" data-testid="checkout-link-done">
                  Done
                </MButton>
              </template>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
