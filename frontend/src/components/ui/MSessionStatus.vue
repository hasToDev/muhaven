<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { Zap } from 'lucide-vue-next'
import { useWalletStore } from '@/stores/wallet'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{ size?: 'sm' | 'md' }>(), { size: 'md' })

const wallet = useWalletStore()

// Re-fetch the provider's expiry every 30s. `refreshSessionState` mutates
// the reactive `sessionExpirySec` ref in the store, which this component's
// computeds already track — so the interval alone drives re-renders. No
// local tick ref needed. 30s is coarse enough not to thrash (display is
// minute-level), frequent enough to make the countdown visible in demos.
let intervalId: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  wallet.refreshSessionState()
  intervalId = setInterval(() => wallet.refreshSessionState(), 30_000)
})

onBeforeUnmount(() => {
  if (intervalId) clearInterval(intervalId)
})

const label = computed(() => {
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

const visible = computed(() => wallet.sessionKeyActive && !!label.value)

const tooltip = computed(() =>
  `Session key active — ${label.value} left. Distribute + claim actions sign silently until it expires.`,
)
</script>

<template>
  <span
    v-if="visible"
    data-testid="session-status"
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
