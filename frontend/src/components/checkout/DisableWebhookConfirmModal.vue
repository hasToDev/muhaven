<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { AlertTriangle, X, Loader2 } from 'lucide-vue-next'
import MButton from '@/components/ui/MButton.vue'
import { useModalA11y } from '@/composables/useModalA11y'

/**
 * Wave 4 §5 Path D — destructive-action gate for "Disable webhook".
 *
 * Third-pass review (Frontend M5): single-click disable was a misclick
 * footgun — once disabled the dispatcher stops sending payloads to the
 * issuer's endpoint with no undo affordance. Mirrors the
 * SigningSecretRevealModal acknowledgment pattern: a typed confirmation
 * (the URL itself) gates the destructive Submit. Type-to-confirm matches
 * the Stripe / GitHub / Vercel destructive-action UX so issuers
 * recognise the pattern.
 *
 * UX:
 *   - ESC + backdrop close while not submitting.
 *   - Tab focus-trap inside the modal root.
 *   - The Disable CTA stays disabled until the typed URL matches the
 *     endpoint's URL byte-for-byte (case-sensitive — URLs are
 *     case-sensitive in the path component).
 *   - Pressing Enter inside the input submits.
 */

const props = defineProps<{
  open: boolean
  endpoint: { endpointId: string; url: string } | null
  /** Disable in-flight (parent owns the API call) — keeps the spinner +
   *  disables the Cancel + Disable buttons + ESC dismissal. */
  submitting: boolean
  /** Bubble up to the parent so error rendering stays on the page. */
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  (e: 'confirm', endpointId: string): void
  (e: 'close'): void
}>()

const typed = ref('')
const rootRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)

const expectedUrl = computed(() => props.endpoint?.url ?? '')
const matches = computed(
  () => typed.value.length > 0 && typed.value === expectedUrl.value,
)
const canConfirm = computed(
  () => matches.value && !props.submitting && !!props.endpoint,
)

useModalA11y({
  isOpen: computed(() => props.open),
  rootRef,
  onEscape: () => {
    if (props.submitting) return
    emit('close')
  },
  disableEscape: computed(() => props.submitting),
})

watch(
  () => props.open,
  async (open) => {
    if (open) {
      typed.value = ''
      await nextTick()
      inputRef.value?.focus()
    }
  },
)

function onSubmit(e?: Event) {
  if (e) e.preventDefault()
  if (!canConfirm.value || !props.endpoint) return
  emit('confirm', props.endpoint.endpointId)
}

function onCancel() {
  if (props.submitting) return
  emit('close')
}

function onBackdrop() {
  if (props.submitting) return
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <transition name="fade">
      <div
        v-if="open && endpoint"
        class="fixed inset-0 z-[60] flex items-center justify-center px-4"
        data-testid="webhook-disable-confirm-modal"
      >
        <!-- Backdrop -->
        <div
          class="absolute inset-0 bg-midnight/60 backdrop-blur-sm"
          @click="onBackdrop"
        />
        <div
          ref="rootRef"
          role="dialog"
          aria-modal="true"
          aria-labelledby="disable-webhook-title"
          aria-describedby="disable-webhook-desc"
          class="relative w-full max-w-md bg-white dark:bg-midnight rounded-2xl ring-1 ring-haze dark:ring-white/12 shadow-2xl overflow-hidden"
        >
          <!-- Header -->
          <div class="flex items-start gap-3 px-5 py-4 border-b border-haze/60 dark:border-white/8">
            <div class="flex-shrink-0 mt-0.5 rounded-full bg-negative/12 p-1.5">
              <AlertTriangle :size="16" class="text-negative" aria-hidden="true" />
            </div>
            <div class="flex-1 min-w-0">
              <h2
                id="disable-webhook-title"
                class="font-sans text-base font-semibold text-midnight dark:text-white tracking-tight"
              >
                Disable this endpoint?
              </h2>
              <p
                id="disable-webhook-desc"
                class="mt-0.5 font-sans text-xs text-cool"
              >
                The dispatcher will stop sending payloads to this URL.
                Type the endpoint URL to confirm.
              </p>
            </div>
            <button
              type="button"
              :disabled="submitting"
              :aria-label="'Cancel'"
              class="flex-shrink-0 p-1 rounded-md text-cool hover:text-midnight dark:hover:text-white hover:bg-mist/60 dark:hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              @click="onCancel"
            >
              <X :size="16" aria-hidden="true" />
            </button>
          </div>

          <!-- Body -->
          <form class="px-5 py-4 space-y-3" @submit="onSubmit">
            <div>
              <p class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold">
                Endpoint
              </p>
              <code
                class="block mt-1.5 bg-mist/50 dark:bg-white/3 rounded-md ring-1 ring-haze dark:ring-white/12 px-3 py-2 font-mono text-[11px] text-midnight dark:text-white break-all"
                data-testid="webhook-disable-confirm-url"
              >{{ expectedUrl }}</code>
            </div>
            <label class="block">
              <span class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold">
                Type the URL to confirm
              </span>
              <input
                ref="inputRef"
                v-model="typed"
                type="text"
                spellcheck="false"
                autocomplete="off"
                :disabled="submitting"
                :placeholder="expectedUrl"
                data-testid="webhook-disable-confirm-input"
                class="mt-1.5 w-full bg-white dark:bg-midnight px-3 py-2 rounded-md ring-1 ring-haze dark:ring-white/12 text-xs font-mono text-midnight dark:text-white focus:outline-none focus:ring-2 focus:ring-negative/60 disabled:opacity-50"
              />
            </label>
            <div
              v-if="errorMessage"
              role="alert"
              class="flex items-start gap-2 rounded-md bg-negative/8 ring-1 ring-negative/30 px-3 py-2 text-xs text-negative"
            >
              <AlertTriangle :size="13" class="mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span>{{ errorMessage }}</span>
            </div>
            <!-- Footer / actions -->
            <div class="flex items-center justify-end gap-2 pt-2">
              <MButton
                variant="ghost"
                size="sm"
                type="button"
                :disabled="submitting"
                data-testid="webhook-disable-confirm-cancel"
                @click="onCancel"
              >
                Cancel
              </MButton>
              <MButton
                variant="primary"
                size="sm"
                type="submit"
                :disabled="!canConfirm"
                data-testid="webhook-disable-confirm-submit"
                class="!bg-negative !text-white hover:!bg-negative/90"
              >
                <Loader2 v-if="submitting" :size="14" class="animate-spin" aria-hidden="true" />
                <span>{{ submitting ? 'Disabling…' : 'Disable endpoint' }}</span>
              </MButton>
            </div>
          </form>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
