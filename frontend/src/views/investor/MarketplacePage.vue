<script setup lang="ts">
import { onMounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { useMarketplaceStore } from '@/stores/marketplace'
import { formatUSD } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import { Search, TrendingUp, Shield, Inbox } from 'lucide-vue-next'

const app = useAppStore()
const marketplace = useMarketplaceStore()

const assetClassLabels: Record<string, string> = {
  treasury: 'Treasury',
  money_market: 'Money Market',
  private_credit: 'Private Credit',
  real_estate: 'Real Estate',
  other: 'Other',
}

const assetClassColors: Record<string, string> = {
  treasury: 'bg-compute/12 text-compute',
  money_market: 'bg-gold/12 text-gold',
  private_credit: 'bg-cipher/20 text-cipher',
  real_estate: 'bg-signal/12 text-signal',
  other: 'bg-cool/12 text-cool',
}

onMounted(async () => {
  if (!marketplace.loaded) {
    app.startLoading()
    await marketplace.load()
    app.stopLoading()
  }
})
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="app.isLoading" class="flex flex-col gap-8">
    <MSkeleton variant="title" width="200px" />
    <MSkeleton variant="card" height="56px" />
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      <MSkeleton variant="card" v-for="i in 6" :key="i" height="240px" />
    </div>
  </div>

  <!-- Error state -->
  <div v-else-if="marketplace.error" class="flex flex-col items-center justify-center py-20 gap-4">
    <p class="text-base text-cool">{{ marketplace.error }}</p>
    <MButton variant="outline" @click="marketplace.load()">Retry</MButton>
  </div>

  <!-- Content -->
  <div v-else class="flex flex-col gap-10">
    <div
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white tracking-tight">RWA Marketplace</h1>
      <MGoldRule />
      <p class="text-sm text-cool mt-2">Browse confidential RWA tokens with FHE-encrypted balances</p>
    </div>

    <!-- Search + filters -->
    <div class="flex flex-col sm:flex-row gap-3">
      <div class="flex-1 relative">
        <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-cool" />
        <input
          v-model="marketplace.searchQuery"
          placeholder="Search tokens..."
          data-testid="marketplace-search"
          class="w-full py-2.5 pl-10 pr-4 text-sm font-sans border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white placeholder:text-cool focus:outline-none focus:border-compute focus:ring-2 focus:ring-compute/20 transition-colors"
        />
      </div>

      <!-- Asset class filter -->
      <div class="flex gap-1.5 flex-wrap">
        <button
          @click="marketplace.assetClassFilter = ''"
          data-testid="marketplace-filter-all"
          :class="[
            'px-3 py-2 text-xs font-medium rounded-lg transition-all duration-200 cursor-pointer',
            !marketplace.assetClassFilter
              ? 'bg-compute text-white'
              : 'border border-haze dark:border-white/10 text-cool hover:text-compute hover:border-compute/30',
          ]"
        >
          All
        </button>
        <button
          v-for="ac in marketplace.assetClasses"
          :key="ac"
          @click="marketplace.assetClassFilter = ac as any"
          :data-testid="`marketplace-filter-${ac}`"
          :class="[
            'px-3 py-2 text-xs font-medium rounded-lg transition-all duration-200 cursor-pointer',
            marketplace.assetClassFilter === ac
              ? 'bg-compute text-white'
              : 'border border-haze dark:border-white/10 text-cool hover:text-compute hover:border-compute/30',
          ]"
        >
          {{ assetClassLabels[ac] || ac }}
        </button>
      </div>
    </div>

    <!-- Token grid -->
    <div v-if="marketplace.filtered.length === 0" class="flex flex-col items-center py-16 gap-3">
      <Inbox :size="48" class="text-cool/30" />
      <p class="text-base text-cool">No tokens found</p>
      <p class="text-sm text-cool/70">Try adjusting your search or filters</p>
    </div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      <MCard
        v-for="token in marketplace.filtered"
        :key="token.id"
        hover
        glow
        data-testid="marketplace-token-card"
        :data-token-address="token.address"
      >
        <!-- Header -->
        <div class="flex justify-between items-start mb-4">
          <div>
            <p class="font-sans font-medium text-base text-midnight dark:text-white" data-testid="marketplace-token-name">{{ token.name }}</p>
            <p class="font-mono text-xs text-cool mt-0.5" data-testid="marketplace-token-symbol">{{ token.symbol }}</p>
          </div>
          <MBadge :variant="token.status === 'active' ? 'positive' : 'default'">
            {{ token.status }}
          </MBadge>
        </div>

        <!-- Stats -->
        <div class="space-y-3 mb-4">
          <div class="flex justify-between items-center">
            <span class="text-xs text-cool">APY</span>
            <span v-if="token.apy" class="text-sm font-medium text-gold flex items-center gap-1">
              <TrendingUp :size="12" />
              {{ token.apy }}%
            </span>
            <span v-else class="text-xs text-cool">N/A</span>
          </div>

          <div class="flex justify-between items-center">
            <span class="text-xs text-cool">NAV</span>
            <span v-if="token.latest_nav" class="text-sm font-mono text-midnight dark:text-white">
              {{ formatUSD(parseFloat(token.latest_nav.nav)) }}
            </span>
            <span v-else class="text-xs text-cool">—</span>
          </div>

          <div v-if="token.min_investment" class="flex justify-between items-center">
            <span class="text-xs text-cool">Min Investment</span>
            <span class="text-sm font-mono text-midnight dark:text-white">
              {{ formatUSD(parseFloat(token.min_investment)) }}
            </span>
          </div>
        </div>

        <!-- Tags -->
        <div class="flex gap-2 mb-4">
          <span :class="['px-2 py-0.5 rounded text-xs font-medium', assetClassColors[token.asset_class] || 'bg-cool/12 text-cool']">
            {{ assetClassLabels[token.asset_class] || token.asset_class }}
          </span>
          <span class="px-2 py-0.5 rounded text-xs font-medium bg-compute/8 text-compute flex items-center gap-1">
            <Shield :size="10" />
            FHE
          </span>
        </div>

        <!-- Invest button -->
        <RouterLink :to="`/deposit?token=${token.address}`">
          <MButton variant="primary" full-width size="sm" data-testid="marketplace-invest-cta">
            Invest
          </MButton>
        </RouterLink>
      </MCard>
    </div>

    <p class="text-center text-xs text-cool">
      {{ marketplace.filtered.length }} of {{ marketplace.tokens.length }} tokens shown
    </p>
  </div>
  </div>
</template>
