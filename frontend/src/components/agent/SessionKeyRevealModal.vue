<script setup lang="ts">
/**
 * Wave 4 Q1 — SessionKeyRevealModal
 *
 * One-time reveal of the session-key private half so the operator can
 * install it on the broker daemon. The headline affordance is the
 * one-paste `muhaven-broker update --session <key>` command (shipped in
 * `@muhaven/mcp@0.4.0`) — it brings the daemon up if it's down or rotates
 * the key if it's running, in a single paste, so the operator no longer
 * hand-edits `MUHAVEN_BROKER_SESSION_KEY` + restarts. The raw key + the
 * `--session -` stdin form stay available as the advanced path. The key
 * is computed locally (privacy boundary preserved); the backend never
 * sees it.
 *
 * UX contract:
 *   - Modal mints the key (or surfaces the in-memory record if one
 *     already exists for this tab) on mount, never on tab-load. The
 *     parent controls visibility via the `v-if` mount pattern shared
 *     with `LinkTelegramModal`.
 *   - Both the command and the raw hex embed the private key, so both are
 *     masked behind a "Reveal" toggle — a casual onlooker can't
 *     shoulder-surf the value (or the command that contains it) off-screen.
 *   - "Copy broker command" is the primary CTA; "Copy raw key" is the
 *     secondary/advanced fallback. After either copy:
 *       1. Schedules a clipboard wipe ~60s later via a writeText('') —
 *          best-effort; some browsers gate this without recent user
 *          gesture, in which case we no-op silently. The timer is
 *          cleared on unmount, so navigating away cancels the wipe and
 *          the operator's clipboard manager owns hygiene from that point.
 *   - Dismiss flow has two paths:
 *       a) The intentional Close button + click-outside + ESC, all
 *          gated by the acknowledgment checkbox so a stray click can't
 *          dismiss before the operator has actually copied the value.
 *       b) The X corner button + an explicit "Discard without copying"
 *          link in the error / pre-reveal branches, which always work
 *          so the user can bail out of an error state or a regretted
 *          mint without first having to lie to themselves.
 */

import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Key, Copy, Check, X, Eye, EyeOff, AlertTriangle } from 'lucide-vue-next'
import { useWalletStore } from '@/stores/wallet'
import type { ExportedSessionKey } from '@/providers/wallet-provider.interface'
import { formatAddress } from '@/lib/utils'

const walletStore = useWalletStore()

/**
 * `preMinted` (Wave 5 Path D Pickup A) lets the caller surface a key
 * that's ALREADY been minted out-of-band (e.g. via
 * `walletStore.installScopedSessionKey` during the Scoped tier transition
 * commit) instead of triggering the legacy in-tab mint inside the modal.
 * When set, `mintAndReveal` short-circuits to the supplied key; the
 * privacy contract is identical (privateKey lives only in the parent's
 * reactive ref until acknowledge/close → no localStorage write).
 */
const props = defineProps<{
  preMinted?: ExportedSessionKey | null
}>()

const emit = defineEmits<{ close: [] }>()

const loading = ref(true)
const error = ref<string | null>(null)
const exported = ref<ExportedSessionKey | null>(null)
const revealed = ref(false)
/** Which artefact was last copied — drives the per-button "Copied" flash
 *  and the shared clipboard-wipe notice. `null` = nothing copied yet. The
 *  broker command and the raw key are distinct copy targets but share one
 *  reset timer (you only ever copy one at a time). */
const copiedTarget = ref<'cmd' | 'key' | null>(null)
const acknowledged = ref(false)
/** R2 A11y H-2 — the Scoped post-commit path auto-mounts this modal
 *  from a network round-trip, so without an explicit focus transfer the
 *  keyboard user is stranded on the now-disabled Submit button. The X
 *  button is the always-dismissible escape hatch; landing focus on it
 *  also triggers the SR announcement of the modal label + role. */
const xButtonRef = ref<HTMLButtonElement | null>(null)
let copyResetHandle: ReturnType<typeof setTimeout> | null = null
let clipboardWipeHandle: ReturnType<typeof setTimeout> | null = null
const CLIPBOARD_WIPE_MS = 60_000

/**
 * Gates the intentional dismiss paths (Close button + ESC + click-outside)
 * once the operator has acknowledged seeing the key. The X corner button
 * + the error/loading branch use `forceClose()` so the user is never
 * actually trapped — e.g. when `mintAndReveal` failed and there's no key
 * to acknowledge in the first place.
 */
const canDismiss = computed(() => acknowledged.value === true)

const truncatedHex = computed<string>(() => {
  if (!exported.value) return ''
  const hex = exported.value.privateKey
  return `${hex.slice(0, 6)}…${hex.slice(-6)}`
})

/**
 * The one-paste broker command — `muhaven-broker update --session <key>`.
 * `update` is the universal verb: it brings the daemon up if it's down and
 * rotates the key (stop → swap → restart, reusing the JWT) if it's already
 * running, so the operator never has to choose between `start`/`update`.
 * `brokerCmd` carries the FULL key (what gets copied); `brokerCmdMasked` is
 * the shoulder-surf-safe display until the operator hits Reveal.
 */
const brokerCmd = computed<string>(() =>
  exported.value ? `muhaven-broker update --session ${exported.value.privateKey}` : '',
)
const brokerCmdMasked = computed<string>(() =>
  exported.value ? `muhaven-broker update --session ${truncatedHex.value}` : '',
)

const expiresLabel = computed<string>(() => {
  if (!exported.value) return ''
  const sec = exported.value.expiresAtSec - Math.floor(Date.now() / 1000)
  if (sec <= 0) return 'Expired'
  const minutes = Math.floor(sec / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
})

async function mintAndReveal(): Promise<void> {
  loading.value = true
  error.value = null
  revealed.value = false
  // Wave 5 Path D Pickup A — if the parent supplied a pre-minted key
  // (Scoped tier transition path), surface it directly. Skips the legacy
  // exportSessionKey path so the Scoped EOA the caller minted doesn't
  // get replaced by the in-tab session-key.
  if (props.preMinted) {
    exported.value = props.preMinted
    loading.value = false
    return
  }
  // Defence in depth — the page-side gate already short-circuits when
  // walletStore.connected is false, but a future call site (deep-link,
  // direct mount) could land here without a kernel. Surface a clean
  // error instead of letting `ensureConnected()` throw the generic
  // "No wallet connected" string.
  if (!walletStore.connected) {
    error.value = 'Connect your wallet first — minting needs an active ZeroDev kernel.'
    loading.value = false
    return
  }
  try {
    const data = await walletStore.exportSessionKey()
    if (!data) {
      throw new Error('No session key available — sign in again.')
    }
    exported.value = data
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/**
 * Schedule a best-effort clipboard wipe — same security trade-off as
 * 1Password's auto-clear. Browsers may gate clipboard.writeText when no
 * recent user gesture is present; the catch is intentional. Shared by both
 * copy targets (command + raw key) so whichever was copied last is the one
 * the wipe clears.
 */
function scheduleClipboardWipe(): void {
  if (clipboardWipeHandle !== null) clearTimeout(clipboardWipeHandle)
  clipboardWipeHandle = setTimeout(() => {
    navigator.clipboard.writeText('').catch(() => {
      /* permission denied — operator's clipboard manager owns hygiene */
    })
  }, CLIPBOARD_WIPE_MS)
}

/**
 * Copy either the one-paste broker command (`'cmd'`, primary) or the raw
 * private key (`'key'`, advanced). Both embed the secret, so both schedule
 * the same auto-wipe. Surfaces a clean error if the clipboard write is
 * blocked (e.g. insecure context / permission denied).
 */
async function copy(target: 'cmd' | 'key'): Promise<void> {
  if (!exported.value) return
  const text = target === 'cmd' ? brokerCmd.value : exported.value.privateKey
  try {
    await navigator.clipboard.writeText(text)
    copiedTarget.value = target
    if (copyResetHandle !== null) clearTimeout(copyResetHandle)
    copyResetHandle = setTimeout(() => {
      copiedTarget.value = null
    }, 2400)
    scheduleClipboardWipe()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Clipboard write blocked'
  }
}

function toggleReveal(): void {
  revealed.value = !revealed.value
}

/**
 * Intentional close — only fires when the operator has checked the ack
 * box. Wipes the in-memory mirror BEFORE emitting close so any
 * synchronous parent holding the modal instance briefly can't read it.
 */
function close(): void {
  if (!canDismiss.value) return
  forceClose()
}

/**
 * Escape hatch for the X corner button + the error / pre-reveal branches.
 * Always works — used when there's nothing to acknowledge (mint failed,
 * user wants to bail before revealing).
 */
function forceClose(): void {
  exported.value = null
  revealed.value = false
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // ESC in error / loading state always escapes (matches the X-corner
  // semantics). In the success branch we still require the ack so a
  // stray ESC keystroke can't dismiss a freshly-revealed key.
  if (error.value || !exported.value) {
    forceClose()
    return
  }
  if (canDismiss.value) close()
}

onMounted(() => {
  void mintAndReveal()
  window.addEventListener('keydown', onKeydown)
  // R2 A11y H-2 — focus the X button so keyboard users land inside the
  // dialog instead of orphaned on the post-commit Submit button. Tab
  // from here moves through the modal's interactive elements (Reveal
  // toggle, Copy, ack checkbox, Close).
  void Promise.resolve().then(() => {
    xButtonRef.value?.focus()
  })
})

onBeforeUnmount(() => {
  if (copyResetHandle !== null) clearTimeout(copyResetHandle)
  if (clipboardWipeHandle !== null) clearTimeout(clipboardWipeHandle)
  window.removeEventListener('keydown', onKeydown)
  // Last-chance clear if the parent yanked the v-if without us going
  // through close(). exported.value is reactive but holds the only
  // long-lived in-memory copy of the hex outside sessionStorage.
  exported.value = null
})
</script>

<template>
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center p-4
           bg-black/55 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="reveal-key-title"
    @click.self="canDismiss ? close() : (error || !exported) && forceClose()"
  >
    <div
      class="relative w-full max-w-[480px] rounded-2xl p-6 sm:p-7
             max-h-[calc(100dvh-2rem)] overflow-y-auto
             border border-haze dark:border-white/10
             bg-frost dark:bg-midnight-mid
             shadow-2xl"
    >
      <!-- X corner — always dismissible. Loading / error states always
           use forceClose (nothing to acknowledge); the success branch
           also force-closes via X so a panic-click can never trap the
           user. The deliberate "I've copied" path is the big Close
           button below + ack checkbox. -->
      <button
        ref="xButtonRef"
        type="button"
        data-testid="reveal-key-x"
        class="absolute top-3 right-3 p-2 rounded-lg
               text-cool hover:text-compute
               dark:text-body-dark dark:hover:text-signal
               focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        aria-label="Close session-key reveal"
        @click="forceClose"
      >
        <X :size="18" />
      </button>

      <div class="flex items-center gap-3 mb-4">
        <div
          class="grid place-items-center size-10 rounded-xl
                 bg-gold/15 text-gold dark:text-signal"
        >
          <Key :size="20" />
        </div>
        <div>
          <h2
            id="reveal-key-title"
            class="font-accent text-[1.25rem] leading-tight text-compute dark:text-signal"
          >
            Session key for broker
          </h2>
          <p class="text-xs text-cool dark:text-body-dark/70 mt-0.5">
            Copy once — you won't see this value again
          </p>
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="p-8 text-center text-cool dark:text-body-dark/70">
        Minting session key…
      </div>

      <!-- Error — always shows a dismiss path so the user is never
           trapped (closes §3e⁶ F-modal-error-dismiss-trap from Q1 self
           review). -->
      <div
        v-else-if="error"
        class="space-y-3"
      >
        <div class="p-4 rounded-xl border border-negative/40 bg-negative/5">
          <div class="flex items-start gap-2 text-sm text-negative">
            <AlertTriangle :size="16" class="mt-0.5 flex-shrink-0" />
            <p>{{ error }}</p>
          </div>
        </div>
        <button
          type="button"
          data-testid="reveal-key-error-close"
          class="w-full inline-flex items-center justify-center gap-2 py-2 px-4 rounded-lg
                 text-sm font-medium
                 border border-haze dark:border-white/10
                 text-compute dark:text-body-dark
                 hover:bg-mist dark:hover:bg-white/5
                 transition-colors duration-150 cursor-pointer"
          @click="forceClose"
        >
          Close
        </button>
      </div>

      <!-- Reveal surface -->
      <div v-else-if="exported" class="space-y-4">
        <!-- Privacy warning banner -->
        <div
          class="p-3 rounded-xl border border-gold/40 bg-gold/8"
        >
          <div class="flex items-start gap-2">
            <AlertTriangle
              :size="16"
              class="mt-0.5 flex-shrink-0 text-gold"
            />
            <p class="text-xs text-compute dark:text-body-dark leading-relaxed">
              Anyone with this key can propose intents on your behalf
              within the configured policy scope. Treat it like a
              password — copy the one-paste broker command below, run it on
              your broker machine, then dismiss this dialog.
            </p>
          </div>
        </div>

        <!-- Metadata -->
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span class="text-cool dark:text-body-dark/60">Smart account</span>
            <p
              class="font-mono text-compute dark:text-signal mt-0.5"
              :title="exported.smartAccountAddress"
            >
              {{ formatAddress(exported.smartAccountAddress) }}
            </p>
          </div>
          <div>
            <span class="text-cool dark:text-body-dark/60">Expires in</span>
            <p class="font-mono text-compute dark:text-signal mt-0.5">
              {{ expiresLabel }}
            </p>
          </div>
        </div>

        <!-- PRIMARY — the one-paste broker command. Embeds the key, so the
             same Reveal toggle masks it (shoulder-surf safety); the copy
             always carries the full command regardless of the toggle. -->
        <div
          class="p-3 rounded-xl border border-haze dark:border-white/10
                 bg-mist/60 dark:bg-midnight/50"
        >
          <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] uppercase tracking-wider text-cool dark:text-body-dark/60">
              One-paste broker command
            </span>
            <button
              type="button"
              data-testid="reveal-key-toggle"
              :aria-pressed="revealed"
              class="inline-flex items-center gap-1 text-xs text-compute dark:text-signal
                     hover:text-compute-hover dark:hover:text-signal-hover cursor-pointer
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 rounded"
              @click="toggleReveal"
            >
              <component
                :is="revealed ? EyeOff : Eye"
                :size="13"
              />
              {{ revealed ? 'Hide' : 'Reveal' }}
            </button>
          </div>
          <p
            data-testid="reveal-key-cmd"
            class="font-mono text-[12px] break-all leading-relaxed text-compute dark:text-body-dark"
            :class="revealed ? 'select-all' : 'select-none'"
          >
            {{ revealed ? brokerCmd : brokerCmdMasked }}
          </p>
        </div>

        <!-- Primary copy CTA — the broker command -->
        <button
          type="button"
          data-testid="reveal-key-copy-cmd"
          class="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg
                 text-sm font-semibold text-white dark:text-[#412d00]
                 bg-compute dark:bg-signal
                 hover:bg-compute-hover dark:hover:bg-signal-hover
                 transition-colors duration-150 cursor-pointer
                 shadow-[0_4px_14px_rgba(184,134,11,0.22)]
                 dark:shadow-[0_4px_14px_rgba(255,220,161,0.2)]"
          @click="copy('cmd')"
        >
          <component :is="copiedTarget === 'cmd' ? Check : Copy" :size="14" />
          {{ copiedTarget === 'cmd' ? 'Command copied' : 'Copy broker command' }}
        </button>
        <p class="text-[11px] text-cool dark:text-body-dark/60 text-center -mt-1.5 leading-relaxed">
          Run it on your broker machine —
          <code class="font-mono">update</code> brings the daemon up if it's
          down, or rotates the key if it's already running. No env-var edits.
        </p>

        <!-- SECONDARY / advanced — the raw key (env-var or stdin workflows) -->
        <div
          class="p-3 rounded-xl border border-haze/70 dark:border-white/5
                 bg-mist/30 dark:bg-midnight/30"
        >
          <span class="block mb-2 text-[11px] uppercase tracking-wider text-cool dark:text-body-dark/70">
            Raw private key · advanced
          </span>
          <p
            data-testid="reveal-key-hex"
            class="font-mono text-[12px] break-all leading-relaxed text-compute dark:text-body-dark"
            :class="revealed ? 'select-all' : 'select-none'"
          >
            {{ revealed ? exported.privateKey : truncatedHex }}
          </p>
          <button
            type="button"
            data-testid="reveal-key-copy"
            class="mt-2.5 w-full inline-flex items-center justify-center gap-2 py-2 px-4 rounded-lg
                   text-xs font-medium
                   border border-haze dark:border-white/10
                   text-compute dark:text-body-dark
                   hover:bg-mist dark:hover:bg-white/5
                   transition-colors duration-150 cursor-pointer"
            @click="copy('key')"
          >
            <component :is="copiedTarget === 'key' ? Check : Copy" :size="13" />
            {{ copiedTarget === 'key' ? 'Raw key copied' : 'Copy raw key' }}
          </button>
          <p class="mt-2 text-[11px] text-cool dark:text-body-dark/70 leading-relaxed">
            Keep the key out of <code class="font-mono text-[11px]">ps</code>/argv — pipe via stdin:
            <code class="font-mono text-[11px] break-all">echo &lt;key&gt; | muhaven-broker update --session -</code>
          </p>
        </div>

        <p
          v-if="copiedTarget"
          data-testid="reveal-key-copied-hint"
          class="text-[11px] text-positive text-center -mt-1"
        >
          {{ copiedTarget === 'cmd' ? 'Run it on your broker now' : 'Paste it into your broker now' }}
          — the clipboard will be cleared ~60s after copying as long as
          this dialog stays open.
        </p>
        <!-- Persistent live region (always mounted, text-only swap) so the
             copy confirmation is reliably announced — a v-if-inserted
             live region can be missed by AT. Mirrors ScopedSessionBanner. -->
        <span class="sr-only" role="status" aria-live="polite">
          {{
            copiedTarget === 'cmd'
              ? 'Broker command copied to clipboard'
              : copiedTarget === 'key'
                ? 'Raw key copied to clipboard'
                : ''
          }}
        </span>

        <!-- Acknowledgment gate -->
        <label
          class="flex items-start gap-2 p-3 rounded-xl
                 border border-haze dark:border-white/10
                 bg-haze/30 dark:bg-white/5
                 cursor-pointer"
        >
          <input
            v-model="acknowledged"
            type="checkbox"
            data-testid="reveal-key-ack"
            class="mt-0.5 size-4 accent-compute dark:accent-signal"
          />
          <span class="text-xs text-compute dark:text-body-dark leading-relaxed">
            I've run
            <code class="font-mono text-[11px]">muhaven-broker update --session …</code>
            on my broker machine (or stored the key in a password manager).
            The key lives only in this browser tab — closing it and re-opening
            this page mints a fresh key, which would mean re-running
            <code class="font-mono text-[11px]">update --session</code> on the broker.
          </span>
        </label>

        <button
          type="button"
          :disabled="!canDismiss"
          data-testid="reveal-key-close"
          class="w-full inline-flex items-center justify-center gap-2 py-2 px-4 rounded-lg
                 text-sm font-medium
                 border border-haze dark:border-white/10
                 text-compute dark:text-body-dark
                 hover:bg-mist dark:hover:bg-white/5
                 disabled:opacity-50 disabled:cursor-not-allowed
                 transition-colors duration-150 cursor-pointer"
          @click="close"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>
