<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { IdentityRegistryClient } from '@muhaven/sdk'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildReadContext } from '@/services/v35/context'
import { AlertTriangle } from 'lucide-vue-next'

// MDevModeBanner — ADR-023 safety banner.
//
// Polls `IdentityRegistry.devMode()` once per minute. When true, renders a
// red top-of-viewport banner so no one forgets the KYC bypass is active.
// The banner also reads `devModeDisabled` — once the latch fires, the banner
// hides forever (post Phase 8 production cutover).
//
// Failure modes are silent: unconfigured registry → render nothing. Network
// error → keep the last known state (default `null` = hidden). This keeps the
// banner from flashing on/off during transient RPC flakes.

const POLL_INTERVAL_MS = 60_000

const devMode = ref<boolean | null>(null)
const disabledForever = ref<boolean>(false)

let pollTimer: ReturnType<typeof setInterval> | null = null
let destroyed = false

async function refresh() {
  if (isZeroAddress(v35Addresses.identityRegistry)) return
  try {
    const client = new IdentityRegistryClient(
      buildReadContext(),
      v35Addresses.identityRegistry,
    )
    const [dm, disabled] = await Promise.all([
      client.devMode(),
      client.devModeDisabled(),
    ])
    if (destroyed) return
    devMode.value = dm
    disabledForever.value = disabled
  } catch (e) {
    // Quietly keep the last state. See note above.
    console.warn('[MDevModeBanner] poll failed:', e)
  }
}

onMounted(() => {
  refresh()
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS)
})

onBeforeUnmount(() => {
  destroyed = true
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <!-- Fixed at the very top of the viewport with z-[60] so it sits above the
       `fixed top-0 z-40` Sidebar. Sidebar/main get a tiny dev-mode visual
       overlap on the top edge — acceptable for a temporary state. -->
  <div
    v-if="devMode === true && !disabledForever"
    role="status"
    data-testid="dev-mode-banner"
    class="fixed top-0 left-0 right-0 z-[60] bg-gradient-to-r from-negative/95 via-negative to-negative/95 text-white
           shadow-[0_4px_14px_rgba(0,0,0,0.35)]"
  >
    <div class="max-w-7xl mx-auto flex items-center justify-center gap-3 px-4 py-2.5">
      <AlertTriangle :size="16" :stroke-width="2" class="flex-shrink-0" />
      <p class="font-sans text-xs md:text-sm font-semibold tracking-wide text-center">
        DEV MODE ACTIVE — KYC bypassed. Do not use with real funds.
      </p>
    </div>
    <!-- Decorative bottom glow -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-white/40 to-transparent"
    />
  </div>
</template>
