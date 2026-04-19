<script setup lang="ts">
import { onMounted } from 'vue'
import { usePortfolioStore } from '@/stores/portfolio'
import { useAppStore } from '@/stores/app'
import { useWallet } from '@/composables/useWallet'
import MCard from '@/components/ui/MCard.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import MButton from '@/components/ui/MButton.vue'
import PortfolioDonut from '@/components/charts/PortfolioDonut.vue'
import { Shield, Lock, Unlock, Eye, DollarSign, Percent, Loader2, EyeOff } from 'lucide-vue-next'
import { formatUSD } from '@/lib/utils'

const app = useAppStore()
const portfolio = usePortfolioStore()
const { address } = useWallet()

onMounted(async () => {
  if (address.value) {
    app.startLoading()
    await portfolio.load(address.value as `0x${string}`)
    app.stopLoading()
  }
})

async function decryptAll() {
  if (!address.value) return
  const pending = portfolio.holdings
    .map((h, i) => h.decryptedBalance === null ? i : -1)
    .filter(i => i >= 0)
  await Promise.all(
    pending.map(i => portfolio.decryptHolding(i, address.value as `0x${string}`)),
  )
}

async function decryptOne(index: number) {
  if (!address.value) return
  await portfolio.decryptHolding(index, address.value as `0x${string}`)
}

async function decryptPusdc() {
  if (!address.value) return
  await portfolio.decryptPusdc(address.value as `0x${string}`)
}

function formatTokenAmount(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
}

function holdingColorClass(index: number): string {
  const colors = ['bg-compute', 'bg-midnight dark:bg-signal', 'bg-cipher']
  return colors[index % colors.length]
}
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="app.isLoading" class="flex flex-col gap-8">
    <div>
      <MSkeleton variant="text" :lines="1" width="160px" />
      <MSkeleton variant="title" width="320px" height="48px" class="mt-3" />
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <MSkeleton variant="card" v-for="i in 3" :key="i" height="100px" />
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <MSkeleton variant="card" v-for="i in 3" :key="i" height="150px" />
    </div>
    <MSkeleton variant="chart" height="220px" />
  </div>

  <!-- Error state -->
  <div v-else-if="portfolio.error" class="flex flex-col items-center justify-center py-20 gap-4">
    <p class="text-base text-cool">{{ portfolio.error }}</p>
    <MButton variant="outline" @click="address && portfolio.load(address as `0x${string}`)">
      Retry
    </MButton>
  </div>

  <!-- Empty state -->
  <div v-else-if="portfolio.loaded && portfolio.holdings.length === 0" class="flex flex-col items-center justify-center py-20 gap-4">
    <Shield :size="48" class="text-cool/40" />
    <p class="text-base text-cool">No holdings yet</p>
    <p class="text-sm text-cool/70">Deposit funds and invest in RWA tokens to build your portfolio.</p>
    <RouterLink to="/deposit">
      <MButton>Make a Deposit</MButton>
    </RouterLink>
  </div>

  <!-- Content -->
  <div v-else class="flex flex-col gap-10">
    <!-- Hero value -->
    <div
      v-motion
      :initial="{ opacity: 0, y: 30, scale: 0.98 }"
      :visible-once="{ opacity: 1, y: 0, scale: 1, transition: { duration: 600 } }"
    >
      <p class="text-xs uppercase tracking-wider text-cool font-sans font-medium mb-1">
        Total Portfolio Value
      </p>
      <MGoldRule />
      <div class="flex items-baseline gap-4 mt-3">
        <template v-if="portfolio.allDecrypted">
          <span class="text-5xl md:text-6xl font-accent italic text-midnight dark:text-white tracking-tight">
            {{ formatUSD(portfolio.totalDecryptedValue) }}
          </span>
        </template>
        <template v-else>
          <div class="flex items-center gap-3">
            <Lock :size="28" class="text-compute/50" />
            <span class="text-3xl md:text-4xl font-accent italic text-cool/50 tracking-tight">
              Encrypted
            </span>
            <MButton variant="outline" size="sm" @click="decryptAll">
              <Eye :size="14" class="mr-1.5" />
              Reveal All
            </MButton>
          </div>
        </template>
      </div>
    </div>

    <!-- Secondary stats row -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <MSummaryCard
        label="USDC Balance"
        :value="portfolio.usdcBalance !== null ? formatUSD(Number(portfolio.usdcBalance) / 1e6) : '—'"
        :icon="DollarSign"
      />
      <MSummaryCard
        label="Holdings"
        :value="`${portfolio.holdings.length} assets`"
        :icon="Percent"
      />
      <MSummaryCard
        label="FHE Status"
        value="Active"
        sub="Balances encrypted (euint128)"
        :icon="Shield"
      />
    </div>

    <!-- Holdings cards — privacy-first -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
      <MCard
        v-for="(h, i) in portfolio.holdings"
        :key="h.tokenAddress"
        hover
        glow
        :class="i === 0 && portfolio.holdings.length > 1 ? 'md:col-span-2' : ''"
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: i * 120 } }"
      >
        <div class="flex justify-between items-center mb-4">
          <span class="font-sans font-medium text-base text-midnight dark:text-white">{{ h.name }}</span>
          <span class="font-mono text-xs text-cool">{{ h.symbol }}</span>
        </div>

        <!-- Decrypted state -->
        <template v-if="h.decryptedBalance !== null">
          <p :class="['font-accent italic text-midnight dark:text-white mb-3', i === 0 ? 'text-3xl' : 'text-2xl']">
            {{ h.nav ? formatUSD(Number(h.decryptedBalance) / 1e18 * h.nav) : `${formatTokenAmount(Number(h.decryptedBalance) / 1e18)} tokens` }}
          </p>
          <div class="flex gap-3 items-center text-base">
            <span class="text-slate">{{ formatTokenAmount(Number(h.decryptedBalance) / 1e18) }} {{ h.symbol }}</span>
            <span v-if="h.apy" class="text-gold font-medium">&uarr; {{ h.apy }}% APY</span>
          </div>
          <div class="mt-3">
            <MBadge variant="positive">
              <Unlock :size="10" class="mr-1" />
              Decrypted
            </MBadge>
          </div>
        </template>

        <!-- Decrypting state -->
        <template v-else-if="h.decrypting">
          <div class="flex items-center gap-3 py-4">
            <Loader2 :size="20" class="text-compute animate-spin" />
            <span class="text-sm text-cool">Decrypting via CoFHE coprocessor...</span>
          </div>
        </template>

        <!-- Encrypted state (default — privacy first) -->
        <template v-else>
          <div class="flex items-center gap-3 py-2 mb-3">
            <Lock :size="18" class="text-compute/60" />
            <span class="text-lg font-accent italic text-cool/50">Balance encrypted</span>
          </div>
          <div class="flex gap-3 items-center text-base">
            <span v-if="h.apy" class="text-gold font-medium">&uarr; {{ h.apy }}% APY</span>
            <span class="text-xs text-cool">{{ h.assetClass.replace('_', ' ') }}</span>
          </div>
          <div class="mt-3">
            <MButton variant="outline" size="sm" @click="decryptOne(i)">
              <Eye :size="12" class="mr-1.5" />
              Decrypt Balance
            </MButton>
          </div>
        </template>

        <div class="mt-2">
          <MBadge variant="privacy">FHE Encrypted</MBadge>
        </div>
      </MCard>

      <!-- USDC card (non-encrypted) -->
      <MCard
        v-if="portfolio.usdcBalance !== null"
        hover
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: portfolio.holdings.length * 120 } }"
      >
        <div class="flex justify-between items-center mb-4">
          <span class="font-sans font-medium text-base text-midnight dark:text-white">Cash Buffer</span>
          <span class="font-mono text-xs text-cool">USDC</span>
        </div>
        <p class="text-2xl font-accent italic text-midnight dark:text-white mb-3">
          {{ formatUSD(Number(portfolio.usdcBalance) / 1e6) }}
        </p>
        <span class="text-xs text-cool">Standard ERC-20 (not encrypted)</span>
      </MCard>

      <!-- PUSDC card (confidential stablecoin — plaintext portion + opt-in decrypt for confidential portion) -->
      <MCard
        v-if="portfolio.pusdcPublicBalance !== null"
        hover
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: (portfolio.holdings.length + 1) * 120 } }"
      >
        <div class="flex justify-between items-center mb-4">
          <span class="font-sans font-medium text-base text-midnight dark:text-white">Confidential USDC</span>
          <MBadge variant="privacy">PUSDC</MBadge>
        </div>

        <!-- Public portion (readable on-chain) -->
        <div class="mb-3">
          <p class="text-xs font-sans text-cool mb-1 uppercase tracking-wider">Public portion</p>
          <p class="text-2xl font-accent italic text-midnight dark:text-white">
            {{ formatUSD(Number(portfolio.pusdcPublicBalance) / 1e6) }}
          </p>
        </div>

        <!-- Confidential portion — decrypt on demand -->
        <div class="pt-3 border-t border-haze dark:border-white/8">
          <p class="text-xs font-sans text-cool mb-2 uppercase tracking-wider">Confidential portion</p>
          <div v-if="portfolio.pusdcConfidentialBalance !== null" class="flex items-center justify-between gap-3">
            <p class="text-2xl font-accent italic text-cipher">
              {{ formatUSD(Number(portfolio.pusdcConfidentialBalance) / 1e6) }}
            </p>
            <button
              @click="decryptPusdc"
              :disabled="portfolio.pusdcDecrypting"
              class="text-[11px] font-sans text-cool hover:text-compute transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
              title="Re-read + decrypt"
            >
              <Loader2 v-if="portfolio.pusdcDecrypting" :size="12" class="animate-spin" />
              <EyeOff v-else :size="12" />
              Refresh
            </button>
          </div>
          <MButton
            v-else
            size="sm"
            full-width
            :loading="portfolio.pusdcDecrypting"
            :disabled="portfolio.pusdcDecrypting"
            @click="decryptPusdc"
          >
            <Eye :size="14" />
            Decrypt confidential balance
          </MButton>
        </div>

        <!-- Scoped error display — a failed decrypt doesn't wipe the page -->
        <div
          v-if="portfolio.pusdcError"
          class="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-negative/8 border border-negative/15"
        >
          <p class="text-[11px] font-sans text-negative leading-relaxed">
            {{ portfolio.pusdcError }}
          </p>
        </div>

        <div class="mt-3 pt-3 border-t border-haze dark:border-white/8">
          <p class="text-[11px] font-sans text-cool leading-relaxed">
            Total = public + confidential. Only you can decrypt the confidential portion (FHE permit).
          </p>
        </div>
      </MCard>
    </div>

    <!-- Allocation with donut chart -->
    <MCard
      v-if="portfolio.allDecrypted"
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 200 } }"
    >
      <div class="flex items-center justify-between mb-5">
        <p class="text-base font-sans font-medium text-midnight dark:text-white">Allocation</p>
      </div>
      <div class="flex flex-col md:flex-row gap-6 items-center">
        <div class="w-40 md:w-52 flex-shrink-0">
          <PortfolioDonut />
        </div>
        <div class="flex-1 w-full">
          <div class="flex h-3 rounded-full overflow-hidden gap-0.5 mb-4">
            <div
              v-for="(h, i) in portfolio.holdings"
              :key="h.tokenAddress"
              v-show="h.decryptedBalance !== null"
              :class="[holdingColorClass(i), 'rounded-full transition-all duration-1000 ease-out']"
              :style="{ width: `${portfolio.totalDecryptedValue > 0 ? ((Number(h.decryptedBalance!) / 1e18 * (h.nav ?? 1)) / portfolio.totalDecryptedValue * 100) : 0}%` }"
            />
          </div>
          <div class="flex flex-wrap gap-5">
            <div v-for="(h, i) in portfolio.holdings" :key="h.tokenAddress" class="flex items-center gap-2">
              <div :class="['w-2.5 h-2.5 rounded-sm', holdingColorClass(i)]" />
              <span class="text-xs text-slate">
                {{ h.name }} &middot;
                {{ portfolio.totalDecryptedValue > 0 ? ((Number(h.decryptedBalance!) / 1e18 * (h.nav ?? 1)) / portfolio.totalDecryptedValue * 100).toFixed(0) : 0 }}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </MCard>

    <MPrivacyBanner text="All token balances are encrypted on-chain via Fhenix FHE. Click 'Decrypt' to reveal — only you can see this data." />
  </div>
  </div>
</template>
