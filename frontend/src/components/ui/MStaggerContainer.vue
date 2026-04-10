<script setup lang="ts">
import { useScrollAnimation } from '@/composables/useScrollAnimation'

const props = defineProps<{
  delay?: number
  stagger?: number
  tag?: string
  animation?: 'fade-up' | 'fade-left' | 'scale'
}>()

const { target, isVisible } = useScrollAnimation(0.1)
const baseDelay = props.delay ?? 0
const staggerMs = props.stagger ?? 120
const animationType = props.animation ?? 'fade-up'
</script>

<template>
  <component :is="tag ?? 'div'" ref="target">
    <slot
      :is-visible="isVisible"
      :base-delay="baseDelay"
      :stagger-ms="staggerMs"
      :animation="animationType"
    />
  </component>
</template>
