<script setup lang="ts">
import MCard from '@/components/ui/MCard.vue'
import MBadge from '@/components/ui/MBadge.vue'
import { Check, Clock, Loader2, XCircle } from 'lucide-vue-next'

defineProps<{
  status: 'pending' | 'confirmed' | 'complete' | 'failed'
  description: string
  txHash?: string
}>()

const statusConfig: Record<string, { icon: typeof Check; variant: 'teal' | 'positive' | 'negative'; label: string }> = {
  pending: { icon: Clock, variant: 'teal', label: 'Pending' },
  confirmed: { icon: Loader2, variant: 'teal', label: 'Confirming' },
  complete: { icon: Check, variant: 'positive', label: 'Complete' },
  failed: { icon: XCircle, variant: 'negative', label: 'Failed' },
}
</script>

<template>
  <MCard class="my-2">
    <div class="flex items-center gap-3 mb-3">
      <component
        :is="statusConfig[status].icon"
        :size="16"
        :class="[
          status === 'confirmed' && 'animate-spin',
          status === 'complete' ? 'text-positive' : status === 'failed' ? 'text-negative' : 'text-compute',
        ]"
      />
      <MBadge
        :variant="statusConfig[status].variant"
        :pulse="status === 'pending' || status === 'confirmed'"
      >
        {{ statusConfig[status].label }}
      </MBadge>
    </div>
    <p class="text-sm text-slate dark:text-cool leading-relaxed">{{ description }}</p>
    <p v-if="txHash" class="font-mono text-[11px] text-cool/60 mt-2">TX: {{ txHash }}</p>
  </MCard>
</template>
