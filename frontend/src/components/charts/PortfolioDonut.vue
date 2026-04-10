<script setup lang="ts">
import { computed } from 'vue'
import { Doughnut } from 'vue-chartjs'
import { Chart as ChartJS, ArcElement, Tooltip } from 'chart.js'
import { useAppStore } from '@/stores/app'
import { PORTFOLIO } from '@/data/constants'

ChartJS.register(ArcElement, Tooltip)

const store = useAppStore()

const chartData = computed(() => ({
  labels: PORTFOLIO.holdings.map(h => h.name),
  datasets: [{
    data: PORTFOLIO.holdings.map(h => h.value),
    backgroundColor: store.isDark
      ? ['#A8F5EC', '#4DB8B0', '#7AADA9']
      : ['#1B9E8A', '#1A1A2E', '#4DB8B0'],
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
      bodyFont: { family: 'Syne' },
      callbacks: {
        label: (ctx: any) => ` $${ctx.parsed.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      },
    },
  },
}))
</script>

<template>
  <div class="relative" style="height: 180px">
    <Doughnut :data="chartData" :options="chartOptions" />
    <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      <span class="text-xs text-cool">Total</span>
      <span class="text-lg font-accent italic text-midnight dark:text-white">
        ${{ PORTFOLIO.totalValue.toLocaleString('en-US', { minimumFractionDigits: 2 }) }}
      </span>
    </div>
  </div>
</template>
