<script setup lang="ts">
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  BarElement, Tooltip,
} from 'chart.js'
import { useAppStore } from '@/stores/app'
import { TOKEN_GROWTH_DATA } from '@/data/constants'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip)

const props = defineProps<{
  symbol: string
}>()

const store = useAppStore()

const chartData = computed(() => {
  const data = TOKEN_GROWTH_DATA[props.symbol]
  if (!data) return { labels: [], datasets: [] }
  return {
    labels: data.labels,
    datasets: [{
      data: data.values,
      backgroundColor: store.isDark ? '#A8F5EC' : '#1B9E8A',
      borderRadius: 3,
      barThickness: 14,
    }],
  }
})

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: {
      grid: { display: false },
      ticks: { color: '#7AADA9', font: { family: 'Syne', size: 10 } },
    },
    y: {
      display: false,
    },
  },
  plugins: {
    tooltip: {
      backgroundColor: '#1A1A2E',
      bodyColor: '#FFFFFF',
      padding: 8,
      bodyFont: { family: 'Syne', size: 11 },
      callbacks: {
        label: (ctx: any) => ` ${ctx.parsed.y} investors`,
      },
    },
  },
}))
</script>

<template>
  <div style="height: 80px">
    <Bar :data="chartData" :options="(chartOptions as any)" />
  </div>
</template>
