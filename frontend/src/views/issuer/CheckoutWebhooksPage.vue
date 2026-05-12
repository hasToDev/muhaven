<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowLeft, Plus, AlertCircle, Loader2, Trash2 } from 'lucide-vue-next'
import { useCheckoutStore } from '@/stores/checkout'
import { checkoutApi, type RegisterWebhookEndpointResponse } from '@/services/api'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import SigningSecretRevealModal from '@/components/checkout/SigningSecretRevealModal.vue'

const store = useCheckoutStore()

const url = ref('')
const enabledEventsRaw = ref('')
const submitting = ref(false)
const submitError = ref<string | null>(null)

const reveal = ref<{
  open: boolean
  secret: string | null
  endpointId: string | null
  url: string | null
}>({ open: false, secret: null, endpointId: null, url: null })

const disablingId = ref<string | null>(null)

onMounted(() => {
  store.loadWebhooks().catch(() => {})
})

const canSubmit = computed(() => url.value.trim().length > 0 && !submitting.value)

async function handleRegister() {
  submitError.value = null
  if (!canSubmit.value) return
  submitting.value = true
  try {
    const events = enabledEventsRaw.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const res: RegisterWebhookEndpointResponse = await checkoutApi.registerWebhook({
      url: url.value.trim(),
      ...(events.length ? { enabledEvents: events } : {}),
    })
    // Show secret reveal modal, then refresh the list (modal close resets).
    reveal.value = {
      open: true,
      secret: res.signingSecret,
      endpointId: res.endpointId,
      url: res.url,
    }
    url.value = ''
    enabledEventsRaw.value = ''
    await store.loadWebhooks()
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : 'Register failed'
  } finally {
    submitting.value = false
  }
}

async function handleDisable(endpointId: string) {
  if (disablingId.value) return
  disablingId.value = endpointId
  try {
    const res = await checkoutApi.disableWebhook(endpointId)
    store.markWebhookDisabled(res.endpointId, res.disabledAt)
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : 'Disable failed'
  } finally {
    disablingId.value = null
  }
}

function closeReveal() {
  reveal.value = { open: false, secret: null, endpointId: null, url: null }
}
</script>

<template>
  <div class="space-y-6">
    <!-- Back link -->
    <RouterLink
      to="/checkout"
      class="inline-flex items-center gap-1.5 text-xs font-sans font-medium text-cool hover:text-compute dark:hover:text-signal transition-colors cursor-pointer"
      data-testid="checkout-webhooks-back"
    >
      <ArrowLeft :size="14" />
      Back to sessions
    </RouterLink>

    <!-- Header -->
    <div>
      <h1 class="font-sans font-bold text-2xl text-midnight dark:text-white tracking-tight">
        Checkout webhooks
      </h1>
      <p class="font-sans text-sm text-cool mt-1">
        Stripe-style HMAC-signed deliveries on every session transition. Register a target URL and receive signed events.
      </p>
    </div>

    <!-- Register form -->
    <section class="bg-white dark:bg-midnight-mid rounded-xl ring-1 ring-haze/40 dark:ring-white/8 shadow-lg shadow-compute/5 p-6">
      <h2 class="font-sans font-semibold text-base text-midnight dark:text-white tracking-tight">
        Register a new endpoint
      </h2>
      <p class="font-sans text-[11px] text-cool mt-1">
        The signing secret is shown ONCE on success. Save it before closing.
      </p>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
        <label class="block md:col-span-2">
          <span class="font-label text-[11px] tracking-[0.14em] uppercase text-cool font-semibold">Webhook URL</span>
          <input
            v-model="url"
            type="url"
            placeholder="https://your-server.example/webhooks/muhaven"
            data-testid="webhook-form-url"
            class="mt-1.5 w-full bg-white dark:bg-midnight px-3 py-2 rounded-md ring-1 ring-haze dark:ring-white/12 text-sm font-mono text-midnight dark:text-white focus:outline-none focus:ring-2 focus:ring-gold/60"
          />
        </label>
        <label class="block">
          <span class="font-label text-[11px] tracking-[0.14em] uppercase text-cool font-semibold">Event types <span class="font-sans normal-case tracking-normal text-cool/60">(comma-separated, blank = all)</span></span>
          <input
            v-model="enabledEventsRaw"
            type="text"
            placeholder="checkout.session.settled, checkout.session.failed"
            data-testid="webhook-form-events"
            class="mt-1.5 w-full bg-white dark:bg-midnight px-3 py-2 rounded-md ring-1 ring-haze dark:ring-white/12 text-xs font-mono text-midnight dark:text-white focus:outline-none focus:ring-2 focus:ring-gold/60"
          />
        </label>
      </div>

      <div v-if="submitError" class="mt-3 flex items-start gap-2 rounded-lg bg-negative/8 ring-1 ring-negative/30 px-3 py-2 text-xs text-negative">
        <AlertCircle :size="14" class="mt-0.5 flex-shrink-0" />
        <span>{{ submitError }}</span>
      </div>

      <div class="mt-4 flex justify-end">
        <MButton
          variant="primary"
          size="sm"
          :disabled="!canSubmit"
          :loading="submitting"
          data-testid="webhook-form-submit"
          @click="handleRegister"
        >
          <Loader2 v-if="submitting" :size="14" class="animate-spin" />
          <Plus v-else :size="14" />
          <span class="ml-1.5">Register endpoint</span>
        </MButton>
      </div>
    </section>

    <!-- List -->
    <div class="bg-white dark:bg-midnight-mid rounded-xl ring-1 ring-haze/40 dark:ring-white/8 shadow-lg shadow-compute/5 overflow-hidden">
      <MPageLoader v-if="store.webhooksLoading && store.webhooks.length === 0" label="Loading webhooks" caption="Reading issuer-scoped registry" />

      <div v-else-if="store.webhooksError" class="p-8 text-center">
        <p class="font-sans text-sm text-negative">{{ store.webhooksError }}</p>
        <MButton variant="outline" size="sm" class="mt-3" @click="store.loadWebhooks()">Retry</MButton>
      </div>

      <div v-else-if="store.webhooks.length === 0" class="p-10 text-center">
        <p class="font-accent italic text-lg text-midnight dark:text-white">No webhooks registered yet.</p>
        <p class="font-sans text-sm text-cool mt-2 max-w-md mx-auto">
          Add an endpoint above to receive signed event deliveries on every session transition.
        </p>
      </div>

      <table v-else class="w-full">
        <thead>
          <tr class="text-left">
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">URL</th>
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Events</th>
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Secret hint</th>
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Status</th>
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Created</th>
            <th class="px-5 py-3 w-12"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-haze/60 dark:divide-white/8">
          <tr
            v-for="e in store.webhooks"
            :key="e.endpointId"
            :data-testid="`webhook-row-${e.endpointId}`"
            class="hover:bg-mist/30 dark:hover:bg-white/3 transition-colors"
          >
            <td class="px-5 py-3 text-xs font-mono text-midnight dark:text-white break-all max-w-xs">
              {{ e.url }}
            </td>
            <td class="px-5 py-3 text-[11px] text-cool font-mono">
              {{ e.enabledEvents.length === 0 ? 'all' : e.enabledEvents.join(', ') }}
            </td>
            <td class="px-5 py-3 text-xs font-mono text-cool/80">
              {{ e.signingSecretHint }}
            </td>
            <td class="px-5 py-3">
              <span v-if="e.disabledAt" class="font-label text-[10px] uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-mist/60 dark:bg-white/5 ring-1 ring-haze dark:ring-white/12 text-cool">Disabled</span>
              <span v-else class="font-label text-[10px] uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-positive/10 ring-1 ring-positive/30 text-positive">Active</span>
            </td>
            <td class="px-5 py-3 text-[11px] text-cool tabular-nums">
              {{ new Date(e.createdAt).toLocaleString() }}
            </td>
            <td class="px-5 py-3 text-right">
              <button
                v-if="!e.disabledAt"
                type="button"
                :disabled="disablingId === e.endpointId"
                :data-testid="`webhook-row-disable-${e.endpointId}`"
                class="inline-flex items-center justify-center w-7 h-7 rounded-md text-cool hover:text-negative hover:bg-negative/10 transition-colors cursor-pointer disabled:opacity-50"
                title="Disable endpoint"
                @click="handleDisable(e.endpointId)"
              >
                <Loader2 v-if="disablingId === e.endpointId" :size="13" class="animate-spin" />
                <Trash2 v-else :size="13" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <SigningSecretRevealModal
      :open="reveal.open"
      :secret="reveal.secret"
      :endpoint-id="reveal.endpointId"
      :url="reveal.url"
      @close="closeReveal"
    />
  </div>
</template>
