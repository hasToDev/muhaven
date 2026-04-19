<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useWallet } from '@/composables/useWallet'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import { balanceApi } from '@/services/api'
import { addresses } from '@/contracts/addresses'
import MCard from './MCard.vue'
import MButton from './MButton.vue'
import MBadge from './MBadge.vue'
import { Copy, Check, RefreshCw, Wallet, ExternalLink } from 'lucide-vue-next'
import { formatUSD, formatAddress } from '@/lib/utils'
import { CIRCLE_FAUCET_URL } from '@/lib/external'

const { address, connected } = useWallet()
const copied = ref(false)
const loading = ref(false)

const usdcBalance = ref<bigint | null>(null)
const formattedBackendBalance = ref<string | null>(null)

async function loadBalances() {
  if (!address.value) return
  loading.value = true
  try {
    const [usdc, backend] = await Promise.allSettled([
      Erc20Service.balanceOf(addresses.usdc, address.value as `0x${string}`),
      balanceApi.get(),
    ])
    usdcBalance.value = usdc.status === 'fulfilled' ? usdc.value : null
    formattedBackendBalance.value = backend.status === 'fulfilled' ? backend.value.formatted_balance : null
  } finally {
    loading.value = false
  }
}

async function copyAddress() {
  if (!address.value) return
  await navigator.clipboard.writeText(address.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

onMounted(() => {
  if (connected.value) loadBalances()
})

watch(connected, (val) => {
  if (val) loadBalances()
})
</script>

<template>
  <MCard v-if="connected && address">
    <div class="flex items-center gap-3 mb-4">
      <div class="w-10 h-10 rounded-lg bg-compute/12 dark:bg-compute/8 flex items-center justify-center">
        <Wallet :size="18" class="text-compute" />
      </div>
      <div>
        <p class="text-base font-sans font-medium text-midnight dark:text-white">Your Smart Account</p>
        <p class="text-xs text-cool">ZeroDev ERC-4337 — gasless transactions</p>
      </div>
    </div>

    <!-- Address display + copy -->
    <div class="flex items-center gap-2 bg-mist/50 dark:bg-midnight/50 rounded-lg px-4 py-3 mb-4">
      <span class="font-mono text-sm text-midnight dark:text-white flex-1 truncate">
        {{ address }}
      </span>
      <MButton variant="ghost" size="sm" @click="copyAddress" class="flex-shrink-0">
        <Check v-if="copied" :size="14" class="text-compute" />
        <Copy v-else :size="14" />
      </MButton>
      <a
        :href="`https://sepolia.arbiscan.io/address/${address}`"
        target="_blank"
        rel="noopener"
        class="flex-shrink-0 text-cool hover:text-compute transition-colors"
      >
        <ExternalLink :size="14" />
      </a>
    </div>

    <!-- Balances -->
    <div class="space-y-3 mb-4">
      <div class="flex justify-between items-center">
        <span class="text-sm text-cool">USDC Balance</span>
        <span class="font-mono text-sm text-midnight dark:text-white">
          <template v-if="usdcBalance !== null">
            {{ formatUSD(Number(usdcBalance) / 1e6) }}
          </template>
          <template v-else>—</template>
        </span>
      </div>
      <div v-if="formattedBackendBalance" class="flex justify-between items-center">
        <span class="text-sm text-cool">Platform Balance</span>
        <span class="font-mono text-sm text-midnight dark:text-white">{{ formattedBackendBalance }}</span>
      </div>
    </div>

    <!-- Refresh -->
    <div class="flex items-center justify-between">
      <MButton variant="ghost" size="sm" @click="loadBalances" :disabled="loading">
        <RefreshCw :size="12" :class="['mr-1.5', loading && 'animate-spin']" />
        Refresh
      </MButton>
      <MBadge v-if="usdcBalance !== null && usdcBalance === 0n" variant="default">
        No funds — send USDC to this address
      </MBadge>
    </div>

    <!-- Funding instructions -->
    <div v-if="usdcBalance !== null && usdcBalance === 0n" class="mt-4 p-4 rounded-lg bg-gold/5 border border-gold/20">
      <div class="flex items-center justify-between gap-3 mb-2">
        <p class="text-sm font-medium text-midnight dark:text-white">Fund your account</p>
        <a
          :href="CIRCLE_FAUCET_URL"
          target="_blank"
          rel="noopener"
          data-testid="fund-account-faucet-link"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-sans font-medium rounded-lg bg-gold/15 text-gold hover:bg-gold/25 transition-colors cursor-pointer"
        >
          Open Circle faucet
          <ExternalLink :size="12" />
        </a>
      </div>
      <ol class="text-xs text-cool space-y-1.5 list-decimal list-inside">
        <li>Copy the address above</li>
        <li>Open the <strong>Circle faucet</strong> and select <strong>USDC</strong> on <strong>Arbitrum Sepolia</strong></li>
        <li>Paste the smart account address and request funds</li>
        <li>Click <strong>Refresh</strong> to see your updated balance</li>
      </ol>
      <p class="text-xs text-cool mt-2">
        USDC contract: <span class="font-mono">{{ formatAddress(addresses.usdc) }}</span>
      </p>
    </div>
  </MCard>
</template>
