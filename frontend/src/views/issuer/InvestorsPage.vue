<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useIssuerInvestorsStore } from '@/stores/issuer-investors'
import { formatAddress } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import {
  Lock, Search, Users, CheckCircle2, ShieldX, ShieldCheck, Loader2,
  ChevronDown, RotateCw,
} from 'lucide-vue-next'

const store = useIssuerInvestorsStore()

onMounted(async () => {
  if (store.loaded) return
  await store.load()
})

const showLoader = computed(() =>
  !store.loaded && !store.error && store.loading,
)

/**
 * Phase 9.A · Expansion (F3) — scoping caption above the table. Frames
 * the per-token holder walk so issuers see at a glance which of their
 * tokens drive the list.
 */
const scopingCaption = computed(() => {
  const symbols = store.scopedTokenSymbols
  if (symbols.length === 0) return ''
  const noun = symbols.length === 1 ? 'token' : 'tokens'
  return `Showing investors holding your ${symbols.length} ${noun} (${symbols.join(', ')})`
})
</script>

<template>
  <div>
    <!-- First-fetch loader -->
    <MPageLoader
      v-if="showLoader"
      label="Loading investor registry"
      caption="Reading KYC + whitelist state"
    />

    <!-- Error -->
    <div v-else-if="store.error && !store.loaded" class="flex flex-col items-center gap-4 py-16">
      <p class="font-sans text-sm text-negative">{{ store.error }}</p>
      <MButton variant="outline" size="sm" @click="store.load()">Retry</MButton>
    </div>

    <!-- Content -->
    <div v-else class="flex flex-col gap-6">
      <!-- Stats strip (4-card grid with corner flourish — Q2 B, Q7 B) -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 460 } }"
        class="grid grid-cols-2 md:grid-cols-4 gap-4"
      >
        <div class="relative overflow-hidden rounded-xl p-4 border border-haze dark:border-white/5 bg-white dark:bg-[#171717]">
          <Users
            aria-hidden="true"
            :size="36"
            :stroke-width="1"
            class="absolute top-3 right-3 text-gold/20 dark:text-signal/20"
          />
          <div class="flex items-center gap-2 mb-2">
            <div class="w-7 h-7 rounded-lg bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 flex items-center justify-center">
              <Users :size="12" :stroke-width="1.8" class="text-compute dark:text-signal" />
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Total</p>
          </div>
          <p class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums tracking-tight leading-none">
            {{ store.stats.total }}
          </p>
        </div>

        <div class="relative overflow-hidden rounded-xl p-4 border border-haze dark:border-white/5 bg-white dark:bg-[#171717]">
          <CheckCircle2
            aria-hidden="true"
            :size="36"
            :stroke-width="1"
            class="absolute top-3 right-3 text-positive/25"
          />
          <div class="flex items-center gap-2 mb-2">
            <div class="w-7 h-7 rounded-lg bg-positive/10 border border-positive/30 flex items-center justify-center">
              <CheckCircle2 :size="12" :stroke-width="1.8" class="text-positive" />
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Eligible</p>
          </div>
          <p class="font-accent italic text-2xl text-positive tabular-nums tracking-tight leading-none">
            {{ store.stats.eligible }}
          </p>
        </div>

        <div class="relative overflow-hidden rounded-xl p-4 border border-haze dark:border-white/5 bg-white dark:bg-[#171717]">
          <ShieldX
            aria-hidden="true"
            :size="36"
            :stroke-width="1"
            class="absolute top-3 right-3 text-negative/25"
          />
          <div class="flex items-center gap-2 mb-2">
            <div class="w-7 h-7 rounded-lg bg-negative/10 border border-negative/30 flex items-center justify-center">
              <ShieldX :size="12" :stroke-width="1.8" class="text-negative" />
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Ineligible</p>
          </div>
          <p class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums tracking-tight leading-none">
            {{ store.stats.ineligible }}
          </p>
        </div>

        <div class="relative overflow-hidden rounded-xl p-4 border border-haze dark:border-white/5 bg-white dark:bg-[#171717]">
          <ShieldCheck
            aria-hidden="true"
            :size="36"
            :stroke-width="1"
            class="absolute top-3 right-3 text-gold/25 dark:text-signal/25"
          />
          <div class="flex items-center gap-2 mb-2">
            <div class="w-7 h-7 rounded-lg bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 flex items-center justify-center">
              <ShieldCheck :size="12" :stroke-width="1.8" class="text-compute dark:text-signal" />
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Rate</p>
          </div>
          <p class="font-accent italic text-2xl text-gold tabular-nums tracking-tight leading-none">
            {{ store.stats.eligibilityRate }}%
          </p>
        </div>
      </section>

      <!-- Attached filter toolbar (Q3 A) -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 460, delay: 60 } }"
        class="rounded-2xl border border-haze dark:border-white/5
               bg-mist/40 dark:bg-[#0d0e10]/70 backdrop-blur-md
               px-5 md:px-6 py-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-4"
      >
        <label for="investors-search" class="sr-only">Search investors by address</label>
        <div class="relative flex-1 sm:max-w-xl">
          <Search
            :size="15"
            :stroke-width="1.8"
            aria-hidden="true"
            class="absolute left-4 top-1/2 -translate-y-1/2 text-cool pointer-events-none"
          />
          <input
            id="investors-search"
            v-model="store.searchQuery"
            placeholder="Search by address (0x…)…"
            aria-label="Search investors by address"
            class="w-full bg-white dark:bg-[#0e0e0e]
                   border border-haze dark:border-white/10 rounded-full
                   pl-11 pr-4 py-2.5 font-mono text-sm
                   text-midnight dark:text-white placeholder:text-cool placeholder:font-sans
                   focus:outline-none focus:border-gold/50 dark:focus:border-signal/40
                   focus:ring-1 focus:ring-gold/30 dark:focus:ring-signal/30
                   transition-colors"
          />
        </div>
        <div class="flex items-center gap-3 sm:ml-auto">
          <label for="investors-kyc-filter"
                 class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold whitespace-nowrap">
            KYC Status
          </label>
          <div class="relative flex-1 sm:flex-none">
            <select
              id="investors-kyc-filter"
              v-model="store.kycFilter"
              aria-label="Filter investors by KYC status"
              class="appearance-none bg-white dark:bg-[#0e0e0e]
                     border border-haze dark:border-white/10 rounded-full
                     pl-5 pr-11 py-2.5 font-sans text-xs uppercase tracking-[0.2em] font-semibold
                     text-slate dark:text-body-dark/80 cursor-pointer w-full sm:min-w-[170px]
                     focus:outline-none focus:border-gold/50 dark:focus:border-signal/40
                     focus:ring-1 focus:ring-gold/30 dark:focus:ring-signal/30
                     transition-colors"
            >
              <option value="all">All status</option>
              <option value="eligible">Eligible only</option>
              <option value="ineligible">Ineligible only</option>
            </select>
            <ChevronDown
              :size="14"
              :stroke-width="1.8"
              class="absolute right-4 top-1/2 -translate-y-1/2 text-cool pointer-events-none"
            />
          </div>
        </div>
      </section>

      <!-- Phase 9.A · Expansion (F3) scoping caption — frames the per-token
           walk so issuers know the list is scoped to their own tokens. -->
      <p
        v-if="scopingCaption"
        data-testid="investors-scoping-caption"
        class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold -mt-2"
      >
        {{ scopingCaption }}
      </p>

      <!-- Table (real <table> with horizontal scroll on narrow — Q4 A) -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 120 } }"
        class="rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] overflow-hidden"
      >
        <!-- Empty -->
        <div
          v-if="store.filteredInvestors.length === 0"
          class="flex flex-col items-center gap-3 py-16 text-cool"
        >
          <Search :size="32" :stroke-width="1.4" class="opacity-40" />
          <p class="font-sans text-sm">No matching investors</p>
        </div>

        <!-- Table (scrolls horizontally under 900px) -->
        <div v-else class="overflow-x-auto">
          <table class="w-full text-left border-collapse min-w-[900px]">
            <thead class="bg-mist/50 dark:bg-[#0d0e10] border-b border-haze dark:border-white/5">
              <tr>
                <th scope="col" class="py-4 px-6 font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  Address
                </th>
                <th scope="col" class="py-4 px-6 font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  KYC Status
                </th>
                <th scope="col" class="py-4 px-6 font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  Whitelisted
                </th>
                <th scope="col" class="py-4 px-6 font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  Accredited
                </th>
                <th scope="col" class="py-4 px-6 font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold text-right">
                  Balance
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-haze/60 dark:divide-white/5">
              <tr
                v-for="inv in store.filteredInvestors"
                :key="inv.address"
                :class="[
                  'group transition-colors duration-200 cursor-pointer',
                  inv.isEligible
                    ? 'hover:bg-gold/5 dark:hover:bg-signal/5'
                    : 'hover:bg-negative/5',
                ]"
              >
                <!-- Address -->
                <td class="py-5 px-6">
                  <span
                    :class="[
                      'font-mono text-xs tabular-nums tracking-tight transition-colors',
                      'text-midnight dark:text-white',
                      inv.isEligible
                        ? 'group-hover:text-compute dark:group-hover:text-signal'
                        : 'group-hover:text-negative/80',
                    ]"
                  >
                    {{ formatAddress(inv.address) }}
                  </span>
                </td>

                <!-- KYC Status -->
                <td class="py-5 px-6">
                  <span
                    :class="[
                      'inline-flex items-center gap-1.5 font-sans text-[9px] uppercase tracking-[0.22em] font-semibold px-2.5 py-0.5 rounded-full border',
                      inv.isEligible
                        ? 'text-positive border-positive/30 bg-positive/10'
                        : 'text-cool border-haze dark:border-white/15 bg-haze/30 dark:bg-white/5',
                    ]"
                  >
                    <span
                      :class="['w-1.5 h-1.5 rounded-full', inv.isEligible ? 'bg-positive' : 'bg-cool']"
                    />
                    {{ inv.isEligible ? 'Eligible' : 'Ineligible' }}
                  </span>
                </td>

                <!-- Whitelisted -->
                <td class="py-5 px-6">
                  <span
                    :class="[
                      'font-sans text-sm',
                      inv.isWhitelisted ? 'text-midnight dark:text-white' : 'text-cool',
                    ]"
                  >
                    {{ inv.isWhitelisted ? 'Yes' : 'No' }}
                  </span>
                </td>

                <!-- Accredited -->
                <td class="py-5 px-6">
                  <span
                    :class="[
                      'font-sans text-sm',
                      inv.isAccredited ? 'text-midnight dark:text-white' : 'text-cool',
                    ]"
                  >
                    {{ inv.isAccredited ? 'Yes' : 'No' }}
                  </span>
                </td>

                <!-- Balance (FHE Encrypted italic per Q6 A) -->
                <td class="py-5 px-6 text-right">
                  <div
                    :class="[
                      'inline-flex items-center justify-end gap-2 transition-colors',
                      inv.isEligible
                        ? 'text-cool group-hover:text-compute/80 dark:group-hover:text-signal/80'
                        : 'text-cool group-hover:text-negative/70',
                    ]"
                  >
                    <Lock :size="12" :stroke-width="1.8" />
                    <span class="font-accent italic text-xs">FHE Encrypted</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Load more (rotating indicator per Q8 A) -->
      <div v-if="store.hasMore" class="flex justify-center pt-2">
        <button
          type="button"
          :disabled="store.loadingMore"
          @click="store.loadMore()"
          class="inline-flex items-center gap-3 px-8 py-3 rounded-full
                 border border-haze dark:border-white/15
                 font-sans text-[11px] uppercase tracking-[0.22em] font-bold
                 text-cool hover:text-midnight dark:hover:text-white
                 hover:border-gold/50 dark:hover:border-signal/40
                 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
        >
          <Loader2
            v-if="store.loadingMore"
            :size="15"
            :stroke-width="2"
            class="animate-spin text-compute dark:text-signal"
          />
          <RotateCw
            v-else
            :size="15"
            :stroke-width="2"
            class="text-compute/70 dark:text-signal/70 animate-spin"
            style="animation-duration: 4s"
          />
          <span>{{ store.loadingMore ? 'Loading…' : 'Load more' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
