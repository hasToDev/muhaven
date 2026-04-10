<script setup lang="ts">
import { ref, computed } from 'vue'
import { INVESTORS_DATA } from '@/data/constants'
import { useAppStore } from '@/stores/app'
import MCard from '@/components/ui/MCard.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import { Lock, Search, Users, CheckCircle, Clock } from 'lucide-vue-next'

const store = useAppStore()
const searchQuery = ref('')
const kycFilter = ref('all')

const kycOptions = ['all', 'verified', 'pending', 'expired', 'rejected'] as const

const filtered = computed(() => {
  return INVESTORS_DATA.filter(inv => {
    const matchSearch = !searchQuery.value || inv.address.includes(searchQuery.value) || inv.alias.toLowerCase().includes(searchQuery.value.toLowerCase())
    const matchKyc = kycFilter.value === 'all' || inv.kycStatus === kycFilter.value
    return matchSearch && matchKyc
  })
})

const stats = computed(() => {
  const total = INVESTORS_DATA.length
  const verified = INVESTORS_DATA.filter(i => i.kycStatus === 'verified').length
  const pending = INVESTORS_DATA.filter(i => i.kycStatus === 'pending').length
  return {
    total,
    verified,
    pending,
    passRate: Math.round((verified / total) * 100),
  }
})

function kycVariant(status: string) {
  if (status === 'verified') return 'positive'
  if (status === 'pending') return 'gold'
  if (status === 'expired' || status === 'rejected') return 'negative'
  return 'default'
}
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.isLoading" class="flex flex-col gap-8">
    <div>
      <MSkeleton variant="title" width="160px" />
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MSkeleton variant="card" v-for="i in 4" :key="i" height="100px" />
    </div>
    <MSkeleton width="100%" height="44px" />
    <MSkeleton variant="card" height="400px" />
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
      <MBadge variant="teal" class="ml-2 mt-1">Preview Data</MBadge>
    </div>

    <!-- Summary -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MSummaryCard label="Total investors" :value="String(stats.total)" accent :icon="Users" />
      <MSummaryCard label="Verified" :value="String(stats.verified)" :icon="CheckCircle" />
      <MSummaryCard label="Pending review" :value="String(stats.pending)" :icon="Clock" />
      <MSummaryCard label="KYC Pass Rate" :value="`${stats.passRate}%`" :trend="{ value: stats.passRate, direction: 'up' }" />
    </div>

    <!-- Filters -->
    <div class="flex flex-col sm:flex-row gap-3">
      <div class="relative flex-1">
        <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-cool" />
        <input
          v-model="searchQuery"
          placeholder="Search by address or alias..."
          class="w-full pl-10 pr-4 py-2.5 text-sm font-sans border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white placeholder:text-cool focus:outline-none focus:border-compute focus:ring-2 focus:ring-compute/20 transition-colors"
        />
      </div>
      <select
        v-model="kycFilter"
        class="px-4 py-2.5 text-sm font-sans border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white focus:outline-none focus:border-compute cursor-pointer"
      >
        <option v-for="opt in kycOptions" :key="opt" :value="opt">
          {{ opt === 'all' ? 'All KYC Status' : opt.charAt(0).toUpperCase() + opt.slice(1) }}
        </option>
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
      <div class="grid grid-cols-[1fr_100px_80px_100px_140px_80px] gap-4 px-5 py-4 text-xs uppercase tracking-wider text-cool font-sans font-medium border-b border-haze/50 dark:border-white/8">
        <span>Address</span>
        <span>KYC</span>
        <span>Region</span>
        <span>Tokens</span>
        <span>Balance</span>
        <span>Active</span>
      </div>

      <!-- Empty -->
      <div v-if="filtered.length === 0" class="flex flex-col items-center gap-3 py-12 text-cool">
        <Search :size="32" class="opacity-40" />
        <p class="text-sm">No matching investors</p>
      </div>

      <!-- Rows -->
      <div
        v-for="(inv, i) in filtered"
        :key="inv.address"
        v-motion
        :initial="{ opacity: 0, y: 6 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 250, delay: i * 50 } }"
        :class="[
          'grid grid-cols-[1fr_100px_80px_100px_140px_80px] gap-4 px-5 py-4 items-center text-base transition-colors duration-200 hover:bg-mist/30 dark:hover:bg-midnight/30',
          i > 0 && 'border-t border-haze/30 dark:border-white/4',
        ]"
      >
        <div>
          <span class="font-mono text-xs text-midnight dark:text-white">{{ inv.address }}</span>
          <p class="text-xs text-slate mt-0.5">{{ inv.alias }}</p>
        </div>
        <MBadge :variant="kycVariant(inv.kycStatus)" :pulse="inv.kycStatus === 'pending'">
          {{ inv.kycStatus }}
        </MBadge>
        <span class="text-xs text-cool">{{ inv.jurisdiction }}</span>
        <div class="flex gap-1 flex-wrap">
          <span v-for="t in inv.tokens" :key="t" class="font-mono text-[10px] px-1.5 py-0.5 bg-mist dark:bg-midnight rounded text-cool">
            {{ t }}
          </span>
          <span v-if="inv.tokens.length === 0" class="text-xs text-cool/50">--</span>
        </div>
        <div class="flex items-center gap-1.5 text-compute">
          <Lock :size="12" />
          <span class="text-xs font-accent italic">FHE Encrypted</span>
        </div>
        <span class="text-xs text-cool">{{ inv.lastActivity }}</span>
      </div>
    </MCard>

    <!-- Mobile card layout (shown on mobile only) -->
    <div class="md:hidden space-y-3">
      <div v-if="filtered.length === 0" class="flex flex-col items-center gap-3 py-12 text-cool">
        <Search :size="32" class="opacity-40" />
        <p class="text-sm">No matching investors</p>
      </div>

      <MCard
        v-for="(inv, i) in filtered"
        :key="inv.address"
        v-motion
        :initial="{ opacity: 0, y: 8 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 300, delay: i * 60 } }"
      >
        <div class="flex items-start justify-between mb-3">
          <div>
            <p class="text-base font-medium text-midnight dark:text-white">{{ inv.alias }}</p>
            <p class="font-mono text-xs text-cool mt-0.5">{{ inv.address }}</p>
          </div>
          <MBadge :variant="kycVariant(inv.kycStatus)" :pulse="inv.kycStatus === 'pending'">
            {{ inv.kycStatus }}
          </MBadge>
        </div>
        <div class="flex items-center gap-4 text-xs text-cool">
          <span>{{ inv.jurisdiction }}</span>
          <span class="flex items-center gap-1 text-compute">
            <Lock :size="10" />
            FHE Encrypted
          </span>
          <span class="ml-auto">{{ inv.lastActivity }}</span>
        </div>
        <div v-if="inv.tokens.length > 0" class="flex gap-1 mt-2.5">
          <span v-for="t in inv.tokens" :key="t" class="font-mono text-[10px] px-1.5 py-0.5 bg-mist dark:bg-midnight rounded text-cool">
            {{ t }}
          </span>
        </div>
      </MCard>
    </div>

    <MPrivacyBanner text="Individual investor balances are encrypted via Fhenix FHE. You see aggregate data only." />
  </div>
  </div>
</template>
