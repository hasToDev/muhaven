<script setup lang="ts">
import { onMounted } from 'vue'
import { useIssuerInvestorsStore } from '@/stores/issuer-investors'
import { useAppStore } from '@/stores/app'
import { formatAddress } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import { Lock, Search, Users, CheckCircle, ShieldX, ShieldCheck } from 'lucide-vue-next'

const app = useAppStore()
const store = useIssuerInvestorsStore()

function kycVariant(isEligible: boolean) {
  return isEligible ? 'positive' as const : 'negative' as const
}

onMounted(async () => {
  if (!store.loaded) {
    app.startLoading()
    await store.load()
    app.stopLoading()
  }
})
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.loading" class="flex flex-col gap-8">
    <div>
      <MSkeleton variant="title" width="160px" />
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MSkeleton variant="card" v-for="i in 4" :key="i" height="100px" />
    </div>
    <MSkeleton width="100%" height="44px" />
    <MSkeleton variant="card" height="400px" />
  </div>

  <!-- Error -->
  <div v-else-if="store.error && !store.loaded" class="flex flex-col items-center gap-4 py-16">
    <p class="text-negative text-sm">{{ store.error }}</p>
    <MButton variant="ghost" size="sm" @click="store.load()">Retry</MButton>
  </div>

  <!-- Content -->
  <div v-else class="flex flex-col gap-10">
    <div
      class="flex items-center gap-3"
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <div>
        <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white">Investors</h1>
        <MGoldRule />
      </div>
    </div>

    <!-- Summary -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MSummaryCard label="Total investors" :value="String(store.stats.total)" accent :icon="Users" />
      <MSummaryCard label="Eligible" :value="String(store.stats.eligible)" :icon="CheckCircle" />
      <MSummaryCard label="Ineligible" :value="String(store.stats.ineligible)" :icon="ShieldX" />
      <MSummaryCard label="Eligibility Rate" :value="`${store.stats.eligibilityRate}%`" :trend="{ value: store.stats.eligibilityRate, direction: 'up' }" />
    </div>

    <!-- Filters -->
    <div class="flex flex-col sm:flex-row gap-3">
      <div class="relative flex-1">
        <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-cool" />
        <input
          v-model="store.searchQuery"
          placeholder="Search by address (0x...)..."
          class="w-full pl-10 pr-4 py-2.5 text-sm font-sans border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white placeholder:text-cool focus:outline-none focus:border-compute focus:ring-2 focus:ring-compute/20 transition-colors"
        />
      </div>
      <select
        v-model="store.kycFilter"
        class="px-4 py-2.5 text-sm font-sans border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white focus:outline-none focus:border-compute cursor-pointer"
      >
        <option value="all">All Status</option>
        <option value="eligible">Eligible</option>
        <option value="ineligible">Ineligible</option>
      </select>
    </div>

    <!-- Desktop table (hidden on mobile) -->
    <MCard
      padding="none"
      class="hidden md:block"
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400 } }"
    >
      <!-- Header -->
      <div class="grid grid-cols-[1fr_120px_100px_100px_140px] gap-4 px-5 py-4 text-xs uppercase tracking-wider text-cool font-sans font-medium border-b border-haze/50 dark:border-white/8">
        <span>Address</span>
        <span>KYC Status</span>
        <span>Whitelisted</span>
        <span>Accredited</span>
        <span>Balance</span>
      </div>

      <!-- Empty -->
      <div v-if="store.filteredInvestors.length === 0" class="flex flex-col items-center gap-3 py-12 text-cool">
        <Search :size="32" class="opacity-40" />
        <p class="text-sm">No matching investors</p>
      </div>

      <!-- Rows -->
      <div
        v-for="(inv, i) in store.filteredInvestors"
        :key="inv.address"
        v-motion
        :initial="{ opacity: 0, y: 6 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 250, delay: i * 50 } }"
        :class="[
          'grid grid-cols-[1fr_120px_100px_100px_140px] gap-4 px-5 py-4 items-center text-base transition-colors duration-200 hover:bg-mist/30 dark:hover:bg-midnight/30',
          i > 0 && 'border-t border-haze/30 dark:border-white/4',
        ]"
      >
        <div>
          <span class="font-mono text-xs text-midnight dark:text-white">{{ formatAddress(inv.address) }}</span>
        </div>
        <MBadge :variant="kycVariant(inv.isEligible)">
          {{ inv.isEligible ? 'Eligible' : 'Ineligible' }}
        </MBadge>
        <MBadge :variant="inv.isWhitelisted ? 'positive' : 'default'">
          {{ inv.isWhitelisted ? 'Yes' : 'No' }}
        </MBadge>
        <MBadge :variant="inv.isAccredited ? 'gold' : 'default'">
          {{ inv.isAccredited ? 'Yes' : 'No' }}
        </MBadge>
        <div class="flex items-center gap-1.5 text-compute">
          <Lock :size="12" />
          <span class="text-xs font-accent italic">FHE Encrypted</span>
        </div>
      </div>
    </MCard>

    <!-- Mobile card layout -->
    <div class="md:hidden space-y-3">
      <div v-if="store.filteredInvestors.length === 0" class="flex flex-col items-center gap-3 py-12 text-cool">
        <Search :size="32" class="opacity-40" />
        <p class="text-sm">No matching investors</p>
      </div>

      <MCard
        v-for="(inv, i) in store.filteredInvestors"
        :key="inv.address"
        v-motion
        :initial="{ opacity: 0, y: 8 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 300, delay: i * 60 } }"
      >
        <div class="flex items-start justify-between mb-3">
          <div>
            <p class="font-mono text-xs text-midnight dark:text-white">{{ formatAddress(inv.address) }}</p>
          </div>
          <MBadge :variant="kycVariant(inv.isEligible)">
            {{ inv.isEligible ? 'Eligible' : 'Ineligible' }}
          </MBadge>
        </div>
        <div class="flex items-center gap-4 text-xs text-cool">
          <span class="flex items-center gap-1">
            <ShieldCheck :size="10" />
            {{ inv.isWhitelisted ? 'Whitelisted' : 'Not whitelisted' }}
          </span>
          <span v-if="inv.isAccredited" class="text-gold">Accredited</span>
          <span class="flex items-center gap-1 text-compute ml-auto">
            <Lock :size="10" />
            FHE Encrypted
          </span>
        </div>
      </MCard>
    </div>

    <!-- Load more -->
    <div v-if="store.hasMore" class="flex justify-center">
      <MButton variant="ghost" :loading="store.loadingMore" @click="store.loadMore()">
        Load More
      </MButton>
    </div>

    <MPrivacyBanner text="Individual investor balances are encrypted via Fhenix FHE. You see on-chain addresses and KYC eligibility only." />
  </div>
  </div>
</template>
