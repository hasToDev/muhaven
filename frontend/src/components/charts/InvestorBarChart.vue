<script setup lang="ts">
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  BarElement, Tooltip,
} from 'chart.js'
import { useAppStore } from '@/stores/app'
import { COMPLIANCE_DATA } from '@/data/constants'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip)

const store = useAppStore()

const chartData = computed(() => ({
  labels: COMPLIANCE_DATA.jurisdictions.map(j => j.name),
  datasets: [{
    data: COMPLIANCE_DATA.jurisdictions.map(j => j.investors),
    backgroundColor: store.isDark ? '#A8F5EC' : '#1B9E8A',
    borderRadius: 4,
    barThickness: 20,
  }],
}))

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  indexAxis: 'y' as const,
  scales: {
    x: {
      grid: { color: store.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(178,235,230,0.5)' },
      ticks: { color: '#7AADA9', font: { family: 'Syne', size: 11 } },
    },
    y: {
      grid: { display: false },
      ticks: { color: '#7AADA9', font: { family: 'Syne', size: 11 } },
    },
  },
  plugins: {
    tooltip: {
      backgroundColor: '#1A1A2E',
      bodyColor: '#FFFFFF',
      padding: 10,
      bodyFont: { family: 'Syne' },
    },
  },
}))
</script>

<template>
  <div style="height: 180px">
    <Bar :data="chartData" :options="(chartOptions as any)" />
  </div>
</template>
