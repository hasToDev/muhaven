<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { ShieldCheck, Copy, Check, ExternalLink, AlertCircle } from 'lucide-vue-next'

defineProps<{
  session: {
    sessionId: string
    url: string
    fragmentKey: string
    expiresAt: string
  }
}>()

const copyState = ref<'idle' | 'copied'>('idle')
const liveAnnouncement = ref<string>('')
let copyTimer: ReturnType<typeof setTimeout> | null = null

onBeforeUnmount(() => {
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
})

async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    copyState.value = 'copied'
    liveAnnouncement.value = 'Checkout URL copied to clipboard.'
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copyState.value = 'idle'
      liveAnnouncement.value = ''
    }, 1800)
  } catch {
    liveAnnouncement.value = 'Could not copy URL. Select it manually.'
  }
}
</script>

<template>
  <div
    class="rounded-xl bg-positive/8 border border-positive/25 overflow-hidden"
    data-testid="agent-create-checkout-success"
  >
    <!-- aria-live region for copy-success announcement -->
    <span class="sr-only" aria-live="polite" aria-atomic="true">{{ liveAnnouncement }}</span>

    <div class="flex items-start gap-3 px-4 py-3 border-b border-positive/20">
      <ShieldCheck :size="16" :stroke-width="1.8" class="text-positive flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div class="flex-1 min-w-0">
        <p class="font-sans text-sm font-semibold text-positive" role="status">
          Checkout link minted.
        </p>
        <p class="font-sans text-xs text-cool mt-0.5">
          Share the URL with your buyer. The fragment key after <code class="font-mono text-cool/80">#k=</code> decrypts the amount client-side.
        </p>
      </div>
    </div>
    <div class="px-4 py-3 space-y-3">
      <div>
        <p class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold">
          Buyer URL
        </p>
        <code
          class="block mt-1.5 bg-white dark:bg-midnight rounded-md ring-1 ring-haze dark:ring-white/12 px-3 py-2 font-mono text-[11px] text-midnight dark:text-white break-all"
          data-testid="agent-create-checkout-url"
        >{{ session.url }}</code>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          data-testid="agent-create-checkout-copy"
          :aria-label="copyState === 'copied' ? 'Checkout URL copied' : 'Copy checkout URL'"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white dark:bg-midnight ring-1 ring-haze dark:ring-white/12 text-xs font-sans font-semibold text-compute dark:text-signal hover:bg-mist/60 dark:hover:bg-white/5 transition-colors cursor-pointer"
          @click="copyUrl(session.url)"
        >
          <Check v-if="copyState === 'copied'" :size="13" aria-hidden="true" />
          <Copy v-else :size="13" aria-hidden="true" />
          {{ copyState === 'copied' ? 'Copied' : 'Copy URL' }}
        </button>
        <a
          :href="session.url"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="agent-create-checkout-open"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white dark:bg-midnight ring-1 ring-haze dark:ring-white/12 text-xs font-sans font-semibold text-compute dark:text-signal hover:bg-mist/60 dark:hover:bg-white/5 transition-colors"
        >
          Open
          <ExternalLink :size="11" />
        </a>
      </div>
      <div class="flex items-start gap-2 rounded-md bg-mist/50 dark:bg-white/3 px-3 py-2 text-[11px] text-cool font-sans">
        <AlertCircle :size="12" class="mt-0.5 flex-shrink-0 text-gold" />
        <span>
          Save this URL now — the fragment key is shown ONCE and we cannot
          recover it. Expires <span class="font-mono">{{ new Date(session.expiresAt).toLocaleString() }}</span>.
        </span>
      </div>
    </div>
  </div>
</template>
