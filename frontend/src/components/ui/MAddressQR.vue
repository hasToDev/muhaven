<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import QRCode from 'qrcode'

const props = defineProps<{
  address: string | null
  /** Edge size in px when rendered. Defaults to 144. */
  size?: number
  /** Optional label rendered above the QR (e.g. "Scan to copy address"). */
  caption?: string
}>()

const svgMarkup = ref<string>('')
const error = ref<string | null>(null)

async function render() {
  error.value = null
  if (!props.address) {
    svgMarkup.value = ''
    return
  }
  try {
    const svg = await QRCode.toString(props.address, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: {
        dark: '#1a1714',
        light: '#00000000',
      },
    })
    svgMarkup.value = svg
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to render QR'
    svgMarkup.value = ''
  }
}

onMounted(render)
watch(() => props.address, render)
</script>

<template>
  <div class="flex flex-col items-center gap-2">
    <p
      v-if="caption"
      class="font-sans text-[9px] uppercase tracking-[0.22em] text-cool/80"
    >
      {{ caption }}
    </p>
    <div
      :style="{ width: `${size ?? 144}px`, height: `${size ?? 144}px` }"
      class="rounded-lg p-2 bg-white dark:bg-frost
             border border-haze dark:border-white/10
             flex items-center justify-center
             shadow-[0_2px_10px_-4px_rgba(63,46,12,0.18)]
             dark:shadow-[0_2px_10px_-4px_rgba(0,0,0,0.55)]"
      role="img"
      :aria-label="address ? `QR code for address ${address}` : 'QR code unavailable'"
    >
      <div
        v-if="svgMarkup"
        v-html="svgMarkup"
        class="w-full h-full [&>svg]:w-full [&>svg]:h-full"
      />
      <span
        v-else-if="error"
        class="text-[10px] font-sans text-negative px-2 text-center"
      >
        {{ error }}
      </span>
      <span
        v-else
        class="text-[10px] font-sans text-cool/60"
      >
        —
      </span>
    </div>
  </div>
</template>
