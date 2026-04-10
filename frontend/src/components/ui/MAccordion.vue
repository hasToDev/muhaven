<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

defineProps<{
  items: Array<{ title: string; content: string }>
  allowMultiple?: boolean
}>()

const openIndices = ref<Set<number>>(new Set())

function toggle(index: number, allowMultiple?: boolean) {
  if (openIndices.value.has(index)) {
    openIndices.value.delete(index)
  } else {
    if (!allowMultiple) openIndices.value.clear()
    openIndices.value.add(index)
  }
  // Trigger reactivity
  openIndices.value = new Set(openIndices.value)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      v-for="(item, i) in items"
      :key="i"
      :class="cn(
        'bg-white dark:bg-midnight-mid border border-haze dark:border-white/8 rounded-xl transition-all duration-300 faq-item',
        openIndices.has(i) && 'ring-1 ring-compute/15',
      )"
    >
      <button
        class="w-full flex items-center justify-between px-6 py-5 text-left cursor-pointer group"
        @click="toggle(i, allowMultiple)"
      >
        <span class="text-base font-sans font-semibold text-midnight dark:text-white pr-4">
          {{ item.title }}
        </span>
        <ChevronDown
          :size="18"
          :class="cn(
            'text-cool shrink-0 transition-transform duration-200',
            openIndices.has(i) && 'rotate-180',
          )"
        />
      </button>
      <div
        :class="cn(
          'overflow-hidden transition-all duration-300 ease-in-out',
          openIndices.has(i) ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0',
        )"
      >
        <div class="px-6 pb-5 text-[15px] text-slate dark:text-cool leading-relaxed">
          {{ item.content }}
        </div>
      </div>
    </div>
  </div>
</template>
