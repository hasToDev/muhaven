<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { toast } from 'vue-sonner'
import { Droplets, Copy, Check, ExternalLink, X } from 'lucide-vue-next'
import { formatAddress } from '@/lib/utils'
import { CIRCLE_FAUCET_URL } from '@/lib/external'

// Per-wallet so each demo signer dismisses independently. localStorage so the
// dismissal survives page reload — once the user has funded once they don't
// want to see this again. The parent (PortfolioPage) also gates on
// usdcBalance === 0n, so the banner re-appears for genuine drained accounts.
const DISMISS_KEY_PREFIX = 'muhaven-faucet-banner-dismissed:'

const authStore = useAuthStore()
const dismissed = ref(false)
const copied = ref(false)

function dismissKey(): string | null {
  const addr = authStore.walletAddress
  return addr ? `${DISMISS_KEY_PREFIX}${addr.toLowerCase()}` : null
}

function readDismissed() {
  const k = dismissKey()
  dismissed.value = k ? localStorage.getItem(k) === '1' : false
}

onMounted(readDismissed)

// Wallet may hydrate after mount (lazy passkey reconnect). Re-check the
// dismiss flag whenever the address changes so we don't show a banner the
// user previously dismissed for that wallet.
watch(() => authStore.walletAddress, readDismissed)

function dismiss() {
  dismissed.value = true
  const k = dismissKey()
  if (k) localStorage.setItem(k, '1')
}

async function copyAddress() {
  const addr = authStore.walletAddress
  if (!addr) return
  try {
    await navigator.clipboard.writeText(addr)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
    toast.success('Smart account address copied', { description: addr })
  } catch (e) {
    toast.error('Copy failed', {
      description: e instanceof Error ? e.message : 'Clipboard access denied',
    })
  }
}
</script>

<template>
  <div
    v-if="!dismissed && authStore.walletAddress"
    data-testid="faucet-banner"
    v-motion
    :initial="{ opacity: 0, y: -12 }"
    :enter="{ opacity: 1, y: 0, transition: { duration: 400 } }"
    class="relative overflow-hidden rounded-2xl border border-gold/25 bg-gradient-to-r from-gold/8 via-gold/5 to-transparent dark:from-gold/10 dark:via-gold/6 dark:to-transparent"
  >
    <!-- Subtle shimmer accent -->
    <div class="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-gold/50 to-transparent" />

    <div class="flex flex-col sm:flex-row sm:items-center gap-4 p-5">
      <div class="flex items-start gap-3 flex-1 min-w-0">
        <div class="w-10 h-10 rounded-lg bg-gold/15 flex items-center justify-center shrink-0">
          <Droplets :size="18" class="text-gold" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-sans font-semibold text-midnight dark:text-white">
            No testnet USDC yet — grab some from Circle's faucet
          </p>
          <p class="text-xs text-cool mt-0.5 leading-relaxed">
            Choose <strong class="text-midnight dark:text-white font-medium">USDC</strong> on
            <strong class="text-midnight dark:text-white font-medium">Arbitrum Sepolia</strong> and
            paste your smart account address.
          </p>
          <div class="mt-2 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              @click="copyAddress"
              data-testid="faucet-banner-copy"
              :title="authStore.walletAddress ?? ''"
              class="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono rounded-md bg-white/70 dark:bg-midnight/60 border border-haze/70 dark:border-white/10 text-slate dark:text-cool hover:text-compute hover:border-compute/30 transition-colors cursor-pointer"
            >
              <Check v-if="copied" :size="11" class="text-positive" />
              <Copy v-else :size="11" />
              {{ formatAddress(authStore.walletAddress) }}
            </button>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <a
          :href="CIRCLE_FAUCET_URL"
          target="_blank"
          rel="noopener"
          data-testid="faucet-banner-link"
          class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-sans font-medium rounded-lg bg-gold text-midnight hover:bg-gold/90 transition-colors cursor-pointer shadow-sm"
        >
          Open faucet
          <ExternalLink :size="14" />
        </a>
        <button
          type="button"
          @click="dismiss"
          data-testid="faucet-banner-dismiss"
          aria-label="Dismiss faucet banner"
          class="p-2 rounded-lg text-cool hover:text-midnight dark:hover:text-white hover:bg-white/60 dark:hover:bg-white/5 transition-colors cursor-pointer"
        >
          <X :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>
