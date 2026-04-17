<script setup lang="ts">
import { computed } from 'vue'
import { Doughnut } from 'vue-chartjs'
import { Chart as ChartJS, ArcElement, Tooltip } from 'chart.js'
import { useAppStore } from '@/stores/app'
import { usePortfolioStore } from '@/stores/portfolio'
import { formatUSD } from '@/lib/utils'

ChartJS.register(ArcElement, Tooltip)

const store = useAppStore()
const portfolio = usePortfolioStore()

const holdingValues = computed(() =>
  portfolio.holdings
    .filter(h => h.decryptedBalance !== null)
    .map(h => ({
      name: h.name,
      value: Number(h.decryptedBalance!) / 1e18 * (h.nav ?? 1),
    })),
)

const totalValue = computed(() => portfolio.totalDecryptedValue)

const colors = {
  dark: ['#A8F5EC', '#4DB8B0', '#7AADA9', '#C9A84C', '#1B9E8A'],
  light: ['#1B9E8A', '#1A1A2E', '#4DB8B0', '#C9A84C', '#7AADA9'],
}

const chartData = computed(() => ({
  labels: holdingValues.value.map(h => h.name),
  datasets: [{
    data: holdingValues.value.map(h => h.value),
    backgroundColor: store.isDark
      ? colors.dark.slice(0, holdingValues.value.length)
      : colors.light.slice(0, holdingValues.value.length),
    borderWidth: 0,
    hoverOffset: 4,
  }],
}))

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  cutout: '72%',
  plugins: {
    tooltip: {
      backgroundColor: '#1A1A2E',
      titleColor: '#A8F5EC',
      bodyColor: '#FFFFFF',
      borderColor: 'rgba(27,158,138,0.3)',
      borderWidth: 1,
      padding: 12,
      bodyFont: { family: 'Inter Variable' },
      callbacks: {
        label: (ctx: any) => ` $${ctx.parsed.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      },
    },
  },
}))
</script>

<template>
  <div class="relative" style="height: 180px">
    <template v-if="holdingValues.length > 0">
      <Doughnut :data="chartData" :options="chartOptions" />
      <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span class="text-xs text-cool">Total</span>
        <span class="text-lg font-accent italic text-midnight dark:text-white">
          {{ formatUSD(totalValue) }}
        </span>
      </div>
    </template>
    <div v-else class="h-full flex items-center justify-center">
      <span class="text-xs text-cool">Decrypt balances to see allocation</span>
    </div>
  </div>
</template>
