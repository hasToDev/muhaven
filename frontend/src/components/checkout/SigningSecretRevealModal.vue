<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { X, Copy, Check, AlertTriangle, KeyRound } from 'lucide-vue-next'
import MButton from '@/components/ui/MButton.vue'
import { useModalA11y, useBeforeUnloadGuard } from '@/composables/useModalA11y'

const props = defineProps<{
  open: boolean
  secret: string | null
  endpointId: string | null
  url: string | null
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const acknowledged = ref(false)
const copyState = ref<'idle' | 'copied'>('idle')
const liveAnnouncement = ref<string>('')
const rootRef = ref<HTMLElement | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null

// ESC stays DISABLED until the user acknowledges — the secret is shown
// ONCE and a stray ESC keypress would destroy it. The acknowledgment
// checkbox is the explicit "I have copied this" gate.
const escDisabled = computed(() => !acknowledged.value)
useModalA11y({
  isOpen: toRef(props, 'open'),
  rootRef,
  onEscape: () => emit('close'),
  disableEscape: escDisabled,
})

// beforeunload prompt while the modal is open + secret unacknowledged.
// Accidental tab close / refresh / back-button without acknowledging
// destroys the secret silently. Browsers show their native "Are you
// sure?" prompt — accessibility-auditor CRITICAL fix.
const guardActive = computed(() => props.open && !acknowledged.value && props.secret !== null)
useBeforeUnloadGuard(guardActive)

watch(
  () => props.open,
  (open) => {
    if (!open) {
      acknowledged.value = false
      copyState.value = 'idle'
      liveAnnouncement.value = ''
    } else {
      // Pre-fill liveAnnouncement so the screen reader sees the warning
      // copy immediately on modal mount (without needing the user to
      // navigate to the message text).
      liveAnnouncement.value = 'Webhook signing secret revealed. Copy it now — it will not be shown again.'
    }
  },
)

async function copySecret() {
  if (!props.secret) return
  try {
    await navigator.clipboard.writeText(props.secret)
    copyState.value = 'copied'
    liveAnnouncement.value = 'Signing secret copied to clipboard.'
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copyState.value = 'idle'
      // Reset announcement back to the warning so the SR doesn't
      // permanently report "Copied" — the warning is the load-bearing
      // copy.
      liveAnnouncement.value = 'Webhook signing secret revealed. Copy it now — it will not be shown again.'
    }, 1800)
  } catch {
    liveAnnouncement.value = 'Could not copy secret. Select the value manually.'
  }
}

function close() {
  if (!acknowledged.value) return
  emit('close')
}

onBeforeUnmount(() => {
  // Self-review: orphan-timer cleanup. The copyTimer outliving the
  // modal would re-write `copyState`/`liveAnnouncement` on a
  // destroyed component.
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-midnight/40 backdrop-blur-sm"
        data-testid="signing-secret-reveal-modal"
      >
        <div
          ref="rootRef"
          role="dialog"
          aria-modal="true"
          aria-labelledby="signing-secret-modal-title"
          class="w-full max-w-lg bg-white dark:bg-midnight-mid rounded-2xl shadow-2xl ring-1 ring-haze dark:ring-white/8 overflow-hidden"
        >
          <!-- aria-live region for warning + copy state -->
          <span class="sr-only" aria-live="assertive" aria-atomic="true">{{ liveAnnouncement }}</span>

          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-5 border-b border-haze/70 dark:border-white/8">
            <div class="flex items-center gap-2.5">
              <span class="inline-flex w-8 h-8 rounded-lg bg-negative/10 ring-1 ring-negative/30 items-center justify-center">
                <KeyRound :size="16" class="text-negative" aria-hidden="true" />
              </span>
              <div>
                <h2 id="signing-secret-modal-title" class="font-sans font-semibold text-base text-midnight dark:text-white">
                  Webhook signing secret
                </h2>
                <p class="font-sans text-[11px] text-cool mt-0.5">
                  Visible ONCE. Save it in your secret manager now.
                </p>
              </div>
            </div>
            <button
              type="button"
              :disabled="!acknowledged"
              :aria-describedby="!acknowledged ? 'signing-secret-ack-hint' : undefined"
              :class="[
                'p-1.5 rounded-md transition-colors',
                acknowledged
                  ? 'text-cool hover:text-midnight dark:hover:text-white hover:bg-mist/60 dark:hover:bg-white/5 cursor-pointer'
                  : 'text-cool/30 cursor-not-allowed',
              ]"
              aria-label="Close dialog (acknowledge first)"
              @click="close"
            >
              <X :size="18" aria-hidden="true" />
            </button>
          </div>

          <!-- Body -->
          <div class="p-6 space-y-4">
            <div class="rounded-lg bg-negative/8 ring-1 ring-negative/30 px-4 py-3 flex items-start gap-2 text-xs text-negative">
              <AlertTriangle :size="14" class="mt-0.5 flex-shrink-0" />
              <span>
                We do not store the full secret anywhere you can read. Copy it now — if you lose it, you'll have to register a new endpoint and rotate.
              </span>
            </div>

            <div>
              <span class="font-label text-[11px] tracking-[0.14em] uppercase text-cool font-semibold">Endpoint</span>
              <p class="mt-1 font-mono text-[12px] text-midnight dark:text-white break-all">{{ url }}</p>
              <p class="mt-0.5 font-mono text-[10px] text-cool/70">{{ endpointId }}</p>
            </div>

            <div>
              <span class="font-label text-[11px] tracking-[0.14em] uppercase text-cool font-semibold">Signing secret</span>
              <div class="mt-1.5 flex items-stretch gap-2">
                <code
                  class="flex-1 min-w-0 bg-white dark:bg-midnight rounded-md ring-1 ring-haze dark:ring-white/12 px-3 py-2 font-mono text-[12px] text-midnight dark:text-white break-all overflow-x-auto"
                  data-testid="signing-secret-value"
                >{{ secret }}</code>
                <button
                  type="button"
                  data-testid="signing-secret-copy"
                  :aria-label="copyState === 'copied' ? 'Signing secret copied' : 'Copy signing secret to clipboard'"
                  class="inline-flex items-center justify-center px-3 rounded-md bg-mist dark:bg-white/5 ring-1 ring-haze dark:ring-white/8 text-compute dark:text-signal hover:bg-haze/40 transition-colors cursor-pointer"
                  @click="copySecret"
                >
                  <Check v-if="copyState === 'copied'" :size="14" aria-hidden="true" />
                  <Copy v-else :size="14" aria-hidden="true" />
                </button>
              </div>
            </div>

            <label class="flex items-start gap-2 cursor-pointer select-none">
              <input
                v-model="acknowledged"
                type="checkbox"
                data-testid="signing-secret-ack"
                class="mt-1 accent-compute dark:accent-signal cursor-pointer"
              />
              <span
                id="signing-secret-ack-hint"
                class="text-xs text-cool leading-relaxed"
              >
                I've copied this secret to a safe place. I understand it will not be shown again.
              </span>
            </label>
          </div>

          <!-- Footer -->
          <div class="flex items-center justify-end gap-2 px-6 py-4 border-t border-haze/70 dark:border-white/8 bg-mist/40 dark:bg-midnight/40">
            <MButton
              variant="primary"
              size="sm"
              :disabled="!acknowledged"
              data-testid="signing-secret-done"
              @click="close"
            >
              Done
            </MButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
