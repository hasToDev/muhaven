<script setup lang="ts">
import { computed, ref } from 'vue'
import { Doughnut } from 'vue-chartjs'
import { Chart as ChartJS, ArcElement, Tooltip } from 'chart.js'
import { useAppStore } from '@/stores/app'
import { formatUSD } from '@/lib/utils'
import type { AllocationSlice } from '@/stores/portfolio'

ChartJS.register(ArcElement, Tooltip)

const props = defineProps<{
  slices: AllocationSlice[]
  total: number
}>()

const store = useAppStore()

// Chart.js draws tooltips ONTO the canvas, so a HTML overlay sitting on
// top of the canvas would obscure them — z-index doesn't help, the
// tooltip is rendered in canvas pixels. Toggle the centre-label off
// while a slice is hovered. Vue's <transition> keeps the swap subtle.
const isHovering = ref(false)

// Locked slices have value=0; rendering them as zero-area arcs breaks
// Chart.js tooltip math. Filter to revealed, non-zero slices for the arc;
// the legend (in PortfolioPage.vue) shows the locked entries separately.
const renderable = computed(() =>
  props.slices.filter(s => !s.isLocked && s.value > 0),
)

const chartData = computed(() => ({
  labels: renderable.value.map(s => s.name),
  datasets: [{
    data: renderable.value.map(s => s.value),
    backgroundColor: renderable.value.map(s => s.color),
    // Canvas-color separator. Adjacent amber slices (gold + signal) read
    // muddier without a 2px hairline that matches the page background.
    borderColor: store.isDark ? '#121315' : '#FFFDF7',
    borderWidth: 2,
    hoverOffset: 2,
  }],
}))

const tooltipColors = computed(() => store.isDark ? {
  bg: '#1A1B1E',
  title: '#FFDCA1',
  body: '#FAF5E8',
  border: 'rgba(255,186,32,0.25)',
} : {
  bg: '#FFFDF7',
  title: '#B8860B',
  body: '#121315',
  border: 'rgba(184,134,11,0.25)',
})

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  cutout: '76%',
  // Fires on every mouse move over the chart. `elements` is the active-
  // arc list (length > 0 ⇒ pointer is over a slice and the tooltip is
  // showing). We use it to drive the centre-label visibility — the only
  // reliable way since Chart.js's internal hover state isn't exposed
  // declaratively from the Vue wrapper.
  onHover: (_event: unknown, elements: unknown[]) => {
    isHovering.value = elements.length > 0
  },
  plugins: {
    tooltip: {
      backgroundColor: tooltipColors.value.bg,
      titleColor: tooltipColors.value.title,
      bodyColor: tooltipColors.value.body,
      borderColor: tooltipColors.value.border,
      borderWidth: 1,
      padding: 12,
      bodyFont: { family: 'Inter Variable' },
      displayColors: true,
      callbacks: {
        label: (ctx: any) =>
          ` ${ctx.label}: ${formatUSD(ctx.parsed)}`,
      },
    },
  },
}))
</script>

<template>
  <div
    class="relative"
    style="height: 180px"
    data-testid="portfolio-allocation-chart-wrapper"
    :data-slice-count="renderable.length"
    :data-total="total"
  >
    <template v-if="renderable.length > 0">
      <Doughnut :data="chartData" :options="chartOptions" />
      <transition
        enter-active-class="transition-opacity duration-150 ease-out"
        leave-active-class="transition-opacity duration-100 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-show="!isHovering"
          class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
        >
          <span class="font-sans text-[10px] uppercase tracking-[0.2em] text-cool">
            Total
          </span>
          <span class="font-accent italic text-lg text-midnight dark:text-white tabular-nums">
            {{ formatUSD(total) }}
          </span>
        </div>
      </transition>
    </template>
    <div v-else class="h-full flex items-center justify-center" data-testid="portfolio-allocation-empty">
      <span class="font-sans text-xs text-cool">No allocation yet</span>
    </div>
  </div>
</template>
