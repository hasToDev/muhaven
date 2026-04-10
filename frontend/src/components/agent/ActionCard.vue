<script setup lang="ts">
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'

defineProps<{
  title: string
  description: string
  actions: Array<{ label: string; variant: 'primary' | 'secondary' | 'ghost' }>
}>()

const emit = defineEmits<{
  action: [label: string]
}>()
</script>

<template>
  <MCard class="border-l-4 border-l-compute my-2">
    <p class="text-sm font-sans font-medium text-midnight dark:text-white mb-2">{{ title }}</p>
    <p class="text-sm text-slate dark:text-cool leading-relaxed mb-4">{{ description }}</p>
    <div class="flex gap-2">
      <MButton
        v-for="a in actions"
        :key="a.label"
        :variant="a.variant"
        size="sm"
        @click="emit('action', a.label)"
      >
        {{ a.label }}
      </MButton>
    </div>
  </MCard>
</template>
