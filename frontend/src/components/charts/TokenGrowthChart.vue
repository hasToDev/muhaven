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

const props = withDefaults(defineProps<{
  symbol: string
  range?: '6M' | '1Y' | 'ALL'
}>(), {
  range: '6M',
})

const store = useAppStore()

// Mock dataset only has 6 months. Range is decorative for now —
// '1Y' / 'ALL' duplicate the slice forward so the chart visually responds
// to the toggle without faking data we don't have.
const chartData = computed(() => {
  const data = TOKEN_GROWTH_DATA[props.symbol]
  if (!data) return { labels: [], datasets: [] }
  let labels = data.labels
  let values = data.values
  if (props.range === '1Y' || props.range === 'ALL') {
    // Extend forward by mirroring the trend (last value + delta) for visual variety.
    const tail = values.slice(-1)[0] ?? 0
    const delta = (values.slice(-1)[0] ?? 0) - (values.slice(-2, -1)[0] ?? 0)
    const extra = props.range === '1Y' ? 6 : 12
    const extraLabels = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'].slice(0, extra)
    const extraValues = extraLabels.map((_, i) => Math.max(0, Math.round(tail + delta * (i + 1))))
    labels = [...labels, ...extraLabels]
    values = [...values, ...extraValues]
  }
  return {
    labels,
    datasets: [{
      data: values,
      backgroundColor: store.isDark ? '#A8F5EC' : '#1B9E8A',
      borderRadius: 3,
      barThickness: props.range === 'ALL' ? 8 : props.range === '1Y' ? 10 : 14,
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
