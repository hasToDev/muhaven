<script setup lang="ts">
defineProps<{
  variant?: 'default' | 'hero' | 'dark'
}>()
</script>

<template>
  <div class="mesh-gradient" aria-hidden="true">
    <!-- Teal ball — top left -->
    <div
      :class="[
        'mesh-ball bg-compute',
        variant === 'hero' ? 'w-[700px] h-[700px] -top-40 -left-40' : 'w-[600px] h-[600px] -top-32 -left-32',
      ]"
      :style="{ animationDelay: '0s' }"
    />
    <!-- Signal ball — bottom right -->
    <div
      :class="[
        'mesh-ball bg-signal',
        variant === 'hero' ? 'w-[600px] h-[600px] -bottom-40 -right-32' : 'w-[500px] h-[500px] -bottom-32 -right-24',
      ]"
      :style="{ animationDelay: '-7s' }"
    />
    <!-- Cipher ball — center -->
    <div
      :class="[
        'mesh-ball bg-cipher',
        variant === 'hero' ? 'w-[500px] h-[500px] top-1/3 left-1/3' : 'w-[400px] h-[400px] top-1/4 left-1/2',
      ]"
      :style="{ animationDelay: '-14s' }"
    />
  </div>
</template>
