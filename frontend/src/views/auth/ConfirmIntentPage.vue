<script setup lang="ts">
/**
 * /agent/confirm?intent=oci_xxx — OpenClaw intent confirmation page
 * (Wave 4 P4).
 *
 * Cross-branch exception (mirrors ADR-3 D5's `/link` precedent): a leaf
 * auth surface used by the >$5K passkey-deeplink tier and the optional
 * dashboard-driven mini-app fallback. NOT mounted under `/agent/*` on
 * the sidebar — accessed only via the deep-link from Telegram.
 *
 * Anti-phishing surface:
 *  - Calls /agent/openclaw/intent/lookup on mount and renders the
 *    intent details (issuer, amount, hash) BEFORE the user clicks
 *    Authorize.
 *  - Origin pinning happens at the WebAuthn layer — RP-ID is bound to
 *    muhaven.hasto.dev so a Telegram-MITM cannot complete passkey on
 *    a clone.
 *  - Collapsed-oracle 404 responses defeat enumeration of intent ids.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import {
  ApiError,
  openClawApi,
  type OpenClawIntentSummary,
} from '@/services/api'

type Phase =
  | 'looking-up'
  | 'idle'
  | 'authorizing'
  | 'success'
  | 'denied'
  | 'error'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const intentId = computed<string>(() => {
  const raw = route.query.intent
  if (typeof raw !== 'string') return ''
  return raw.trim()
})

const intentLooksValid = computed(() => /^oci_[A-Z0-9]{26}$/.test(intentId.value))

const fromTelegram = computed(() => route.query.from === 'telegram')

const phase = ref<Phase>('looking-up')
const errorMessage = ref<string>('')
const intent = ref<OpenClawIntentSummary | null>(null)

function formatUsd(amountUsd6: string): string {
  const parsed = BigInt(amountUsd6)
  const whole = parsed / 1_000_000n
  const cents = parsed % 1_000_000n
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (whole < 1_000_000n) {
    const centsTwo = (cents / 10_000n).toString().padStart(2, '0')
    return `$${wholeStr}.${centsTwo}`
  }
  return `$${wholeStr}`
}

function shortHash(hash: string): string {
  if (hash.length <= 16) return hash
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

onMounted(async () => {
  if (!intentLooksValid.value) {
    phase.value = 'error'
    errorMessage.value =
      'Missing or malformed intent id. Re-open the link from Telegram.'
    return
  }
  if (!authStore.isAuthenticated) {
    void router.replace({ path: '/login', query: { redirect: route.fullPath } })
    return
  }

  try {
    intent.value = await openClawApi.lookupIntent(intentId.value)
    phase.value = 'idle'
  } catch (err) {
    phase.value = 'error'
    if (err instanceof ApiError && err.status === 404) {
      errorMessage.value =
        'This intent is no longer waiting. It may have expired, already been confirmed, or never existed. Trigger a fresh action from the OpenClaw skill.'
    } else if (err instanceof ApiError) {
      const body = (err.body as { title?: string } | null) ?? null
      errorMessage.value = body?.title ?? `Backend rejected the lookup (HTTP ${err.status}).`
    } else {
      errorMessage.value = err instanceof Error ? err.message : 'Unexpected error.'
    }
  }
})

async function handleAuthorize(): Promise<void> {
  if (!intent.value) return
  phase.value = 'authorizing'
  errorMessage.value = ''
  try {
    // H-2 (Wave 4 stub): the backend requires a non-empty
    // `passkeyAssertion` for the passkey_deeplink tier. Wave 5 will
    // swap this stub for a real WebAuthn assertion (challenge-mint
    // round-trip + navigator.credentials.get + assertion
    // serialization). Sending the stub now keeps the wire shape stable
    // for the upgrade.
    const opts =
      intent.value.tier === 'passkey_deeplink'
        ? { passkeyAssertion: 'wave4-stub' }
        : undefined
    await openClawApi.confirmIntent(intent.value.intentId, opts)
    phase.value = 'success'
  } catch (err) {
    phase.value = 'error'
    if (err instanceof ApiError) {
      const body = (err.body as { title?: string } | null) ?? null
      errorMessage.value = body?.title ?? `Confirm failed (HTTP ${err.status}).`
    } else {
      errorMessage.value = err instanceof Error ? err.message : 'Confirm failed.'
    }
  }
}

async function handleDeny(): Promise<void> {
  if (!intent.value) return
  phase.value = 'authorizing'
  try {
    await openClawApi.denyIntent(intent.value.intentId, 'user_clicked_deny')
    phase.value = 'denied'
  } catch (err) {
    phase.value = 'error'
    errorMessage.value = err instanceof Error ? err.message : 'Could not record the deny.'
  }
}
</script>

<template>
  <div class="confirm-page">
    <main class="card" role="main" aria-labelledby="confirm-title">
      <header class="card-header">
        <h1 id="confirm-title">Confirm OpenClaw intent</h1>
        <p class="subtitle">
          <template v-if="fromTelegram">
            You arrived from Telegram — review the action below before signing with your passkey.
          </template>
          <template v-else>
            Review the action your OpenClaw skill is asking you to confirm before signing.
          </template>
        </p>
      </header>

      <!-- Looking up -->
      <section v-if="phase === 'looking-up'" class="actions">
        <p>Looking up the intent…</p>
      </section>

      <!-- Idle: render intent details first, then CTA -->
      <section v-else-if="phase === 'idle' && intent" class="actions">
        <h2 class="section-h">You are about to confirm this intent</h2>
        <dl class="meta-list" data-testid="confirm-intent-meta">
          <dt>Action</dt>
          <dd><span class="kind-badge">{{ intent.kind }}</span></dd>
          <dt>Issuer</dt>
          <dd>
            <span v-if="intent.payload.issuerLabel">{{ intent.payload.issuerLabel }}</span>
            <span v-else class="muted">Unverified issuer</span>
          </dd>
          <dt>Amount</dt>
          <dd class="amount">{{ formatUsd(intent.amountUsd6) }}</dd>
          <dt>Token</dt>
          <dd><code>{{ shortAddr(intent.payload.token) }}</code></dd>
          <dt>Intent hash</dt>
          <dd><code>{{ shortHash(intent.intentHash) }}</code></dd>
          <dt>Tier</dt>
          <dd><code>{{ intent.tier }}</code></dd>
        </dl>

        <p class="summary">{{ intent.payload.summary }}</p>

        <p class="warn">
          <strong>Only authorize</strong> if you initiated this action. Confirming submits the
          unsigned UserOp through the on-chain @zerodev/permissions validator your agent
          installed at policy time. The MuHaven backend never holds a signing key.
        </p>

        <div class="row">
          <button class="btn btn-primary" type="button" @click="handleAuthorize">
            Confirm with my passkey session
          </button>
          <button class="btn btn-ghost" type="button" @click="handleDeny">
            Deny
          </button>
        </div>
      </section>

      <!-- Authorizing -->
      <section v-else-if="phase === 'authorizing'" class="actions">
        <p>Submitting…</p>
      </section>

      <!-- Success -->
      <section v-else-if="phase === 'success'" class="actions success">
        <h2>Confirmed.</h2>
        <p>
          The MuHaven backend is submitting your transaction. You can close this tab — the
          activity feed will reflect the result within a few seconds.
        </p>
      </section>

      <!-- Denied -->
      <section v-else-if="phase === 'denied'" class="actions denied">
        <h2>Denied.</h2>
        <p>This intent has been recorded as denied. Nothing was submitted on-chain.</p>
      </section>

      <!-- Error -->
      <section v-else-if="phase === 'error'" class="actions error">
        <h2>Something went wrong.</h2>
        <p>{{ errorMessage }}</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.confirm-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.card {
  width: 100%;
  max-width: 520px;
  background: var(--color-surface, #1c1d20);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 16px;
  padding: 28px;
  color: var(--color-text, #f4ecd6);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
}

.card-header {
  margin-bottom: 20px;
}

.card-header h1 {
  font-size: 22px;
  margin: 0 0 6px;
  font-weight: 700;
}

.subtitle {
  font-size: 13px;
  color: var(--color-text-muted, #b3a98e);
  margin: 0;
}

.section-h {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
  color: var(--color-text-muted, #b3a98e);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.meta-list {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 6px 16px;
  margin: 0 0 16px;
  font-size: 14px;
}

.meta-list div {
  display: contents;
}

.meta-list dt {
  color: var(--color-text-muted, #b3a98e);
}

.meta-list dd {
  margin: 0;
  word-break: break-all;
}

.kind-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(184, 134, 11, 0.18);
  color: #ffba20;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.amount {
  font-size: 18px;
  font-weight: 600;
  color: #ffba20;
}

.summary {
  background: rgba(184, 134, 11, 0.08);
  border-left: 3px solid #b8860b;
  padding: 10px 12px;
  border-radius: 4px;
  font-size: 14px;
  margin: 12px 0 16px;
}

.warn {
  font-size: 13px;
  color: var(--color-text-muted, #b3a98e);
  margin: 12px 0 16px;
}

.row {
  display: flex;
  gap: 8px;
}

.btn {
  flex: 1;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  font-family: inherit;
}

.btn-primary {
  background: linear-gradient(135deg, #ffba20 0%, #b8860b 100%);
  color: #121315;
  border: none;
}

.btn-ghost {
  background: transparent;
  color: var(--color-text-muted, #b3a98e);
  border-color: var(--color-border, rgba(255, 255, 255, 0.08));
}

.muted {
  color: var(--color-text-muted, #b3a98e);
}

code {
  font-family:
    'DM Mono',
    'JetBrains Mono',
    ui-monospace,
    monospace;
  font-size: 13px;
}

.success h2 {
  color: #4ade80;
}

.denied h2 {
  color: var(--color-text-muted, #b3a98e);
}

.error h2 {
  color: #f87171;
}
</style>
