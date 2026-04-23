<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useIssuerComplianceStore } from '@/stores/issuer-compliance'
import { useIssuerInvestorsStore } from '@/stores/issuer-investors'
import { formatAddress } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import InvestorBarChart from '@/components/charts/InvestorBarChart.vue'
import {
  Shield, CheckCircle2, Clock, Ban, Plus, BarChart3, Fingerprint,
  AlertCircle, ShieldCheck, Map, PencilLine,
} from 'lucide-vue-next'

const store = useIssuerComplianceStore()
const investorStore = useIssuerInvestorsStore()

onMounted(async () => {
  const loads: Promise<void>[] = []
  if (!store.loaded) loads.push(store.load())
  if (!investorStore.loaded) loads.push(investorStore.load())
  if (loads.length > 0) {
    await Promise.all(loads)
  }
})

const showLoader = computed(() =>
  (!store.loaded && !store.error && store.loading)
  || (!investorStore.loaded && !investorStore.error && investorStore.loading),
)
</script>

<template>
  <div>
    <!-- First-fetch loader -->
    <MPageLoader
      v-if="showLoader"
      label="Loading compliance state"
      caption="Reading KYC gate + jurisdiction data"
    />

    <!-- Error -->
    <div v-else-if="store.error && !store.loaded" class="flex flex-col items-center gap-4 py-16">
      <p class="font-sans text-sm text-negative">{{ store.error }}</p>
      <MButton variant="outline" size="sm" @click="store.load()">Retry</MButton>
    </div>

    <!-- Content -->
    <div v-else class="flex flex-col">
      <!-- HERO + floating stats overlap zone (relative parent for absolute stats) -->
      <div class="relative">
        <!-- Hero bar-chart section (Q2 A) -->
        <section
          v-motion
          :initial="{ opacity: 0, y: 16 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
          class="relative overflow-hidden rounded-2xl border border-haze dark:border-white/5
                 bg-gradient-to-b from-mist/60 dark:from-[#1c1b1b]/60 to-transparent
                 pt-10 pb-28 px-4 md:px-8"
        >
          <!-- ambient bloom -->
          <div
            aria-hidden="true"
            class="absolute -top-24 left-1/2 -translate-x-1/2 w-[520px] h-[260px] rounded-full blur-[120px] pointer-events-none
                   bg-gold/10 dark:bg-signal/10"
          />
          <!-- Title + subtitle centered -->
          <div class="relative z-10 flex flex-col items-center mb-8 text-center">
            <div class="flex items-center gap-3 mb-2">
              <BarChart3 :size="26" :stroke-width="1.7" class="text-compute dark:text-signal" />
              <h3 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                Investors by Jurisdiction
              </h3>
            </div>
            <p class="font-sans text-sm text-cool max-w-lg">
              Global distribution profile tracking real-time investor concentration across target markets.
            </p>
          </div>
          <!-- Chart -->
          <div class="relative z-10 max-w-5xl mx-auto">
            <InvestorBarChart />
          </div>
        </section>

        <!-- Floating glass-panel stats strip (Q3 A — overlaps hero + content) -->
        <section
          v-motion
          :initial="{ opacity: 0, y: 8 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 120 } }"
          class="absolute bottom-0 left-2 right-2 md:left-4 md:right-4 lg:left-8 lg:right-8 translate-y-1/2 z-20"
        >
          <div
            class="rounded-2xl border border-haze dark:border-white/10
                   bg-white/85 dark:bg-[#262626]/75 backdrop-blur-2xl
                   shadow-[0_25px_50px_-12px_rgba(63,46,12,0.18)]
                   dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.65)]
                   p-2 md:p-3
                   flex flex-col sm:flex-row
                   sm:divide-x divide-y sm:divide-y-0
                   divide-haze/70 dark:divide-white/10"
          >
            <!-- Eligible -->
            <div class="flex-1 flex items-center gap-4 px-4 md:px-6 py-3">
              <div class="w-11 h-11 rounded-2xl bg-positive/12 border border-positive/30 flex items-center justify-center flex-shrink-0">
                <CheckCircle2 :size="19" :stroke-width="1.8" class="text-positive" />
              </div>
              <div class="min-w-0">
                <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-bold mb-0.5">
                  Total Eligible
                </p>
                <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums leading-none">
                  {{ store.stats.totalVerified }}
                </p>
              </div>
            </div>
            <!-- Ineligible -->
            <div class="flex-1 flex items-center gap-4 px-4 md:px-6 py-3">
              <div class="w-11 h-11 rounded-2xl bg-mist/80 dark:bg-white/5 border border-haze dark:border-white/10 flex items-center justify-center flex-shrink-0">
                <Clock :size="19" :stroke-width="1.8" class="text-slate dark:text-body-dark/80" />
              </div>
              <div class="min-w-0">
                <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-bold mb-0.5">
                  Ineligible
                </p>
                <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums leading-none">
                  {{ store.stats.pendingReview }}
                </p>
              </div>
            </div>
            <!-- Expiring Soon -->
            <div class="flex-1 flex items-center gap-4 px-4 md:px-6 py-3">
              <div class="w-11 h-11 rounded-2xl bg-gold/12 dark:bg-signal/12 border border-gold/30 dark:border-signal/30 flex items-center justify-center flex-shrink-0">
                <AlertCircle :size="19" :stroke-width="1.8" class="text-gold dark:text-signal" />
              </div>
              <div class="min-w-0">
                <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-bold mb-0.5">
                  Expiring Soon
                </p>
                <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums leading-none">
                  {{ store.stats.expiringSoon }}
                </p>
              </div>
            </div>
            <!-- Blocked -->
            <div class="flex-1 flex items-center gap-4 px-4 md:px-6 py-3">
              <div class="w-11 h-11 rounded-2xl bg-negative/12 border border-negative/30 flex items-center justify-center flex-shrink-0">
                <Ban :size="19" :stroke-width="1.8" class="text-negative" />
              </div>
              <div class="min-w-0">
                <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-bold mb-0.5">
                  Blocked
                </p>
                <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums leading-none">
                  {{ store.stats.blocked }}
                </p>
              </div>
            </div>
          </div>
          <!-- Partial-stats hint (sits under the floating strip) -->
          <p
            v-if="store.stats.isPartial"
            class="font-sans text-[10px] text-cool italic mt-3 text-center"
          >
            Stats based on loaded investors — visit Investors to load the full set.
          </p>
        </section>
      </div>

      <!-- 3-col content grid (Q4 A) — top padding clears the floating strip -->
      <section
        class="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-24"
      >
        <!-- Gate Configuration (Q5 A — stacked rows with dividers) -->
        <div
          v-motion
          :initial="{ opacity: 0, y: 16 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 200 } }"
          class="flex flex-col"
        >
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center gap-2.5">
              <Shield :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" />
              <h4 class="font-sans text-[11px] uppercase tracking-[0.24em] text-cool font-bold">
                Gate Configuration
              </h4>
            </div>
            <button
              type="button"
              disabled
              aria-disabled="true"
              title="Coming soon"
              class="font-sans text-[10px] uppercase tracking-[0.22em] font-bold
                     text-compute/70 dark:text-signal/70
                     flex items-center gap-1
                     cursor-not-allowed opacity-70"
            >
              <PencilLine :size="11" :stroke-width="2" />
              Edit
            </button>
          </div>
          <div class="flex-1 rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-5 md:p-6 flex flex-col">
            <div class="flex justify-between items-center py-2.5">
              <span class="font-sans text-xs text-cool">Provider</span>
              <span class="font-sans text-xs font-semibold text-midnight dark:text-white">{{ store.kycGateConfig.provider }}</span>
            </div>
            <div class="h-px bg-haze/60 dark:bg-white/8" aria-hidden="true" />
            <div class="flex justify-between items-center py-2.5">
              <span class="font-sans text-xs text-cool">Required Level</span>
              <span class="font-sans text-xs font-semibold text-midnight dark:text-white">{{ store.kycGateConfig.requiredLevel }}</span>
            </div>
            <div class="h-px bg-haze/60 dark:bg-white/8" aria-hidden="true" />
            <div class="flex justify-between items-center py-2.5">
              <span class="font-sans text-xs text-cool">Auto-Reject</span>
              <span
                :class="[
                  'font-sans text-xs font-semibold',
                  store.kycGateConfig.autoReject ? 'text-positive' : 'text-cool',
                ]"
              >
                {{ store.kycGateConfig.autoReject ? 'Enabled' : 'Disabled' }}
              </span>
            </div>
            <div class="h-px bg-haze/60 dark:bg-white/8" aria-hidden="true" />
            <div class="flex justify-between items-center py-2.5">
              <span class="font-sans text-xs text-cool">Grace Period</span>
              <span class="font-sans text-xs font-semibold text-midnight dark:text-white">{{ store.kycGateConfig.gracePeriodDays }} days</span>
            </div>
          </div>
        </div>

        <!-- Jurisdictions (Q6 A — flag + name + count, no status pill) -->
        <div
          v-motion
          :initial="{ opacity: 0, y: 16 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 260 } }"
          class="flex flex-col"
        >
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center gap-2.5">
              <Map :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" />
              <h4 class="font-sans text-[11px] uppercase tracking-[0.24em] text-cool font-bold">
                Jurisdiction Overview
              </h4>
            </div>
            <span
              class="font-sans text-[9px] uppercase tracking-[0.22em] font-bold px-2 py-0.5 rounded-full border
                     text-gold dark:text-signal border-gold/30 dark:border-signal/30"
            >
              Preview
            </span>
          </div>
          <ul class="flex-1 rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-2 flex flex-col">
            <li
              v-for="j in store.jurisdictions"
              :key="j.code"
              class="group flex justify-between items-center p-3 rounded-xl hover:bg-mist/50 dark:hover:bg-white/[0.04] transition-colors cursor-default"
            >
              <span class="flex items-center gap-3.5 min-w-0">
                <span
                  :class="[
                    'text-2xl transition-all flex-shrink-0',
                    'filter grayscale group-hover:grayscale-0',
                  ]"
                >
                  {{ j.flag }}
                </span>
                <span class="font-sans text-sm text-slate dark:text-body-dark/80 group-hover:text-midnight dark:group-hover:text-white transition-colors font-medium truncate">
                  {{ j.name }}
                </span>
              </span>
              <span class="flex items-center gap-2 flex-shrink-0">
                <span class="font-mono text-xs font-bold text-midnight dark:text-white tabular-nums bg-mist/70 dark:bg-[#0d0e10] border border-haze dark:border-white/10 px-2.5 py-1 rounded-md">
                  {{ j.investors }}
                </span>
                <span
                  v-if="j.status === 'review'"
                  aria-hidden="true"
                  class="w-1.5 h-1.5 rounded-full bg-gold dark:bg-signal animate-pulse shadow-[0_0_8px_rgba(255,186,32,0.6)] dark:shadow-[0_0_8px_rgba(255,220,161,0.6)]"
                />
              </span>
            </li>
          </ul>
        </div>

        <!-- Trusted Issuers (Q7 A — icon + name + green dot + address / big claims + CLAIMS) -->
        <div
          v-motion
          :initial="{ opacity: 0, y: 16 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 320 } }"
          class="flex flex-col"
        >
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center gap-2.5">
              <ShieldCheck :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" />
              <h4 class="font-sans text-[11px] uppercase tracking-[0.24em] text-cool font-bold">
                Trusted Issuers
              </h4>
            </div>
            <button
              type="button"
              disabled
              aria-disabled="true"
              title="Coming soon"
              class="w-6 h-6 rounded-full flex items-center justify-center
                     text-compute/60 dark:text-signal/60
                     cursor-not-allowed opacity-70"
            >
              <Plus :size="14" :stroke-width="2" />
            </button>
          </div>
          <div class="flex-1 flex flex-col gap-3">
            <div
              v-for="issuer in store.trustedIssuers"
              :key="issuer.address"
              class="group rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717]
                     hover:border-gold/30 dark:hover:border-signal/25 transition-colors
                     p-4 md:p-5
                     flex items-center justify-between gap-3"
            >
              <div class="flex items-center gap-3.5 min-w-0">
                <div class="w-10 h-10 rounded-full bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 flex items-center justify-center flex-shrink-0">
                  <Fingerprint :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" />
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2 mb-0.5">
                    <span class="font-sans text-sm font-bold text-midnight dark:text-white truncate">{{ issuer.name }}</span>
                    <span
                      aria-hidden="true"
                      class="w-1.5 h-1.5 rounded-full bg-positive flex-shrink-0"
                    />
                  </div>
                  <p class="font-mono text-[10px] text-cool group-hover:text-compute/80 dark:group-hover:text-signal/80 transition-colors truncate">
                    {{ formatAddress(issuer.address) }}
                  </p>
                </div>
              </div>
              <div class="text-right flex-shrink-0">
                <div class="font-accent italic text-xl md:text-2xl text-midnight dark:text-white tabular-nums leading-none">
                  {{ issuer.claims }}
                </div>
                <div class="font-sans text-[9px] uppercase tracking-[0.22em] text-cool font-bold mt-1">
                  Claims
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
