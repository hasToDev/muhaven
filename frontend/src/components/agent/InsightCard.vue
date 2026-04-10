<script setup lang="ts">
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import { Sparkles } from 'lucide-vue-next'

defineProps<{
  title: string
  body: string
  suggestions: string[]
}>()

const emit = defineEmits<{
  suggest: [text: string]
}>()
</script>

<template>
  <MCard class="bg-compute/8 dark:bg-compute/8 border-compute/20 dark:border-compute/20 my-2">
    <div class="flex items-center gap-2 mb-3">
      <Sparkles :size="14" class="text-compute" />
      <p class="text-sm font-sans font-medium text-midnight dark:text-white">{{ title }}</p>
    </div>
    <p class="text-sm text-slate dark:text-cool leading-relaxed mb-4">{{ body }}</p>
    <div class="flex flex-wrap gap-2">
      <MButton
        v-for="s in suggestions"
        :key="s"
        variant="ghost"
        size="sm"
        @click="emit('suggest', s)"
      >
        {{ s }}
      </MButton>
    </div>
  </MCard>
</template>
