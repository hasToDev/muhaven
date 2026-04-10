<script setup lang="ts">
defineProps<{
  variant?: 'text' | 'title' | 'card' | 'circle' | 'chart'
  lines?: number
  width?: string
  height?: string
}>()
</script>

<template>
  <div v-if="variant === 'text'" class="space-y-2.5">
    <div
      v-for="i in (lines || 3)"
      :key="i"
      class="animate-pulse bg-haze/40 dark:bg-white/8 rounded-lg h-4"
      :class="i === (lines || 3) ? 'w-3/5' : 'w-full'"
    />
  </div>

  <div
    v-else-if="variant === 'title'"
    class="animate-pulse bg-haze/40 dark:bg-white/8 rounded-lg h-9 w-48"
    :style="{ width, height }"
  />

  <div
    v-else-if="variant === 'card'"
    class="animate-pulse bg-haze/40 dark:bg-white/8 rounded-xl border border-haze/20"
    :style="{ width: width || '100%', height: height || '140px' }"
  />

  <div
    v-else-if="variant === 'circle'"
    class="animate-pulse bg-haze/40 dark:bg-white/8 rounded-full"
    :style="{ width: width || '40px', height: height || '40px' }"
  />

  <div
    v-else-if="variant === 'chart'"
    class="animate-pulse bg-haze/40 dark:bg-white/8 rounded-xl"
    :style="{ width: width || '100%', height: height || '200px' }"
  />

  <div
    v-else
    class="animate-pulse bg-haze/40 dark:bg-white/8 rounded-lg"
    :style="{ width: width || '100%', height: height || '20px' }"
  />
</template>
