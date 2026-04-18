<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { Zap } from 'lucide-vue-next'
import { useWalletStore } from '@/stores/wallet'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{ size?: 'sm' | 'md' }>(), { size: 'md' })

const wallet = useWalletStore()

// Local tick so the minute-countdown re-renders even without a wallet
// operation updating the store. We re-fetch the provider's expiry every
// 30s — fine-grained enough for minute-level display, cheap enough to run
// while the pill is mounted.
const tick = ref(0)
let intervalId: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  wallet.refreshSessionState()
  intervalId = setInterval(() => {
    wallet.refreshSessionState()
    tick.value++
  }, 30_000)
})

onBeforeUnmount(() => {
  if (intervalId) clearInterval(intervalId)
})

const label = computed(() => {
  // Reference `tick` so Vue re-evaluates on each interval beat.
  void tick.value
  const sec = wallet.sessionExpirySec
  if (sec <= 0) return ''
  const mins = Math.ceil(sec / 60)
  if (mins >= 60) {
    const hours = Math.floor(mins / 60)
    const rem = mins % 60
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`
  }
  return `${mins}m`
})

const visible = computed(() => wallet.sessionKeyActive && label.value)

const tooltip = computed(() =>
  `Session key active — ${label.value} left. Distribute + claim actions sign silently until it expires.`,
)
</script>

<template>
  <span
    v-if="visible"
    :class="cn(
      'inline-flex items-center gap-1 rounded-full border border-compute/30 bg-compute/10 text-compute',
      'font-mono tracking-tight select-none',
      props.size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]',
    )"
    :title="tooltip"
  >
    <Zap :size="props.size === 'sm' ? 10 : 12" :stroke-width="2" />
    <span>{{ label }}</span>
  </span>
</template>
