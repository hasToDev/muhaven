<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { IdentityRegistryClient } from '@muhaven/sdk'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildReadContext } from '@/services/v35/context'
import { ShieldAlert } from 'lucide-vue-next'

// MDevModeBanner — ADR-023 dev-mode indicator.
//
// Compact pill rendered at the bottom of the desktop sidebar (and as an
// inline strip on the mobile TopNav). Polls `IdentityRegistry.devMode()`
// once per minute. When true, surfaces a low-key reminder that KYC is
// bypassed without dominating the viewport (the previous viewport-fixed
// banner shifted every page's first scrollable region by ~40px and made
// the layout feel under construction).
//
// `devModeDisabled` latch (post Phase 8 production cutover) hides the
// pill permanently.
//
// Failure modes are silent: unconfigured registry → render nothing.
// Network error → keep last known state.

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
  <!-- Compact sidebar-bottom pill — a single tight row (dot + shield +
       "Dev Mode · KYC bypassed"). The full warning lives in the title
       tooltip so the strip stays slim without dropping the safety signal. -->
  <div
    v-if="devMode === true && !disabledForever"
    role="status"
    data-testid="dev-mode-banner"
    title="KYC verification is bypassed — every address is treated as verified. Do not use with real funds."
    class="group flex items-center gap-1.5 px-2.5 py-1 rounded-md
           bg-negative/8 dark:bg-negative/12
           ring-1 ring-inset ring-negative/25 dark:ring-negative/30
           transition-colors duration-200"
  >
    <!-- Pulsing dot — quiet animation, draws the eye without flashing -->
    <span class="relative flex h-1.5 w-1.5 flex-shrink-0">
      <span
        class="animate-ping absolute inline-flex h-full w-full rounded-full bg-negative opacity-60"
      />
      <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-negative" />
    </span>
    <ShieldAlert
      :size="10"
      :stroke-width="2.2"
      class="text-negative/85 flex-shrink-0"
    />
    <span
      class="text-[9.5px] font-sans font-bold uppercase tracking-[0.14em]
             text-negative/95 dark:text-negative whitespace-nowrap flex-shrink-0"
    >
      Dev Mode
    </span>
    <!-- Wave 6 Polish (mobile round 2): the "· KYC bypassed" suffix is hidden
         below md so the mobile TopNav pill stays compact (it was a big chunk of
         the right-group width that pushed the mobile nav past the viewport →
         horizontal scroll). Desktop sidebar keeps the full text; the title
         tooltip carries the full warning on every surface. -->
    <span
      class="hidden md:inline text-[9px] font-sans text-negative/65 dark:text-negative/55 truncate"
    >
      · KYC bypassed
    </span>
  </div>
</template>
