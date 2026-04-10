<script setup lang="ts">
import { type Component } from 'vue'
import { cn } from '@/lib/utils'
import MCard from './MCard.vue'
import { TrendingUp, TrendingDown } from 'lucide-vue-next'

defineProps<{
  label: string
  value: string
  sub?: string
  accent?: boolean
  size?: 'default' | 'lg'
  icon?: Component
  trend?: { value: number; direction: 'up' | 'down' }
}>()
</script>

<template>
  <MCard :class="cn('flex-1 min-w-0', size === 'lg' && 'p-8')">
    <div class="flex items-center gap-2.5 mb-3">
      <div
        v-if="icon"
        :class="cn(
          'flex items-center justify-center rounded-lg',
          size === 'lg' ? 'w-10 h-10' : 'w-8 h-8',
          'bg-compute/10 text-compute',
        )"
      >
        <component :is="icon" :size="size === 'lg' ? 20 : 16" />
      </div>
      <p class="text-xs uppercase tracking-wider text-cool font-sans font-medium">
        {{ label }}
      </p>
    </div>
    <p
      :class="cn(
        'font-accent italic',
        size === 'lg' ? 'text-4xl' : 'text-2xl',
        accent ? 'text-compute' : 'text-midnight dark:text-white',
      )"
    >
      {{ value }}
    </p>
    <div v-if="trend" class="flex items-center gap-1 mt-1.5">
      <component
        :is="trend.direction === 'up' ? TrendingUp : TrendingDown"
        :size="12"
        :class="trend.direction === 'up' ? 'text-positive' : 'text-negative'"
      />
      <span
        :class="[
          'text-xs font-medium',
          trend.direction === 'up' ? 'text-positive' : 'text-negative',
        ]"
      >
        {{ trend.direction === 'up' ? '+' : '' }}{{ trend.value }}%
      </span>
    </div>
    <p v-else-if="sub" class="text-xs text-cool font-sans mt-1">{{ sub }}</p>
  </MCard>
</template>
