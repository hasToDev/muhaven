<script setup lang="ts">
/**
 * /link?code=ABCD-1234 — device-code authorization page (Wave 4 P3 ADR-3).
 *
 * Cross-branch exception: this is a P2-shaped view shipped on `earlybot`
 * to unblock the device-flow ceremony. Reuses the existing dashboard
 * SIWE/JWT auth (router guard sends unauthenticated visitors through
 * /login first; on return the route preserves the ?code= param).
 *
 * Anti-phishing surface (ADR-3 D4):
 *   - Calls /auth/device/lookup on mount and renders requesterMetadata
 *     (process / hostname / OS) BEFORE the user clicks Authorize.
 *     This is the load-bearing control — without it the user would
 *     have no way to verify the device they are about to authorize.
 *   - One-shot, terminal page — no navigation back to other dashboard
 *     routes from within the success/failure states.
 *   - WebAuthn RP-ID is already pinned to muhaven.hasto.dev by the
 *     parent dashboard; a phishing /link clone cannot complete passkey.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import {
  ApiError,
  deviceFlowApi,
  type DeviceCodeRequesterMetadata,
} from '@/services/api'

type Phase =
  | 'looking-up' // initial GET /auth/device/lookup in flight
  | 'idle' // user can choose Authorize / Deny
  | 'authorizing' // POST /auth/device/authorize in flight
  | 'success' // backend returned authorized
  | 'denied' // user clicked Deny + backend confirmed
  | 'error' // unexpected failure

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const userCode = computed<string>(() => {
  const raw = route.query.code
  if (typeof raw !== 'string') return ''
  return raw.trim().toUpperCase()
})

// Wave 4 P3 ADR-3 §"Code Review #2": Crockford-style alphabet (no O/I/0/1/L)
// matches the backend USER_CODE_REGEX byte-for-byte so the preflight
// can't 200 a code the use-case will then 400.
const codeLooksValid = computed(
  () => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(
    userCode.value,
  ),
)

const phase = ref<Phase>('looking-up')
const errorMessage = ref<string>('')
const requesterMeta = ref<DeviceCodeRequesterMetadata | null>(null)
const expiresAt = ref<string | null>(null)

onMounted(async () => {
  if (!codeLooksValid.value) {
    phase.value = 'error'
    errorMessage.value =
      'Invalid or missing code. Re-run `muhaven-broker login` to get a fresh URL.'
    return
  }
  if (!authStore.isAuthenticated) {
    void router.replace({ path: '/login', query: { redirect: route.fullPath } })
    return
  }

  // Phishing-mitigation: fetch requesterMetadata BEFORE rendering the
  // Authorize CTA. Generic 404 here means the code is invalid /
  // already-authorized / expired — collapse to a single error state so
  // we don't disclose which.
  try {
    const lookup = await deviceFlowApi.lookup(userCode.value)
    requesterMeta.value = lookup.requesterMetadata
    expiresAt.value = lookup.expiresAt
    phase.value = 'idle'
  } catch (err) {
    phase.value = 'error'
    if (err instanceof ApiError && err.status === 404) {
      errorMessage.value =
        'This code is no longer waiting. It may have expired, already been used, or never existed. Re-run `muhaven-broker login` to issue a new one.'
    } else if (err instanceof ApiError) {
      const body = (err.body as { message?: string } | null) ?? null
      errorMessage.value = body?.message ?? `Backend rejected the lookup (HTTP ${err.status}).`
    } else {
      errorMessage.value = err instanceof Error ? err.message : 'Unexpected error.'
    }
  }
})

async function handleAuthorize(): Promise<void> {
  phase.value = 'authorizing'
  errorMessage.value = ''
  try {
    const res = await deviceFlowApi.authorize(userCode.value)
    requesterMeta.value = res.requesterMetadata
    phase.value = 'success'
  } catch (err) {
    phase.value = 'error'
    if (err instanceof ApiError) {
      const body = (err.body as { message?: string } | null) ?? null
      errorMessage.value = body?.message ?? `Backend rejected the request (HTTP ${err.status}).`
    } else {
      errorMessage.value = err instanceof Error ? err.message : 'Unexpected error.'
    }
  }
}

async function handleDeny(): Promise<void> {
  phase.value = 'authorizing'
  try {
    await deviceFlowApi.authorize(userCode.value, { deny: true, denyReason: 'user_clicked_deny' })
    phase.value = 'denied'
  } catch (err) {
    phase.value = 'error'
    errorMessage.value = err instanceof Error ? err.message : 'Could not record the deny.'
  }
}
</script>

<template>
  <div class="link-page" :data-phase="phase" data-testid="link-page">
    <main class="card" role="main" aria-labelledby="link-title">
      <header class="card-header">
        <h1 id="link-title">Link a device to MuHaven</h1>
        <p class="subtitle">
          A MuHaven MCP install is asking for permission to read your portfolio and propose
          actions on your behalf.
        </p>
      </header>

      <!-- Code display (always visible while we have a code) -->
      <section class="code-block" aria-label="Verification code">
        <span class="label">Verification code</span>
        <code class="code-value" data-testid="link-user-code">{{ userCode || '— — — — — — — —' }}</code>
        <p class="hint">
          Make sure this matches the code printed by <code>muhaven-broker login</code> in your terminal.
        </p>
      </section>

      <!-- Looking up: spinner placeholder -->
      <section v-if="phase === 'looking-up'" class="actions" data-testid="link-phase-looking-up">
        <p>Looking up the device…</p>
      </section>

      <!-- Idle: requesterMetadata first, then CTA -->
      <section v-else-if="phase === 'idle'" class="actions" data-testid="link-phase-idle">
        <h2 class="section-h">You are about to authorize this device</h2>
        <dl v-if="requesterMeta" class="meta-list" data-testid="link-requester-meta">
          <dt>Process</dt>
          <dd><code>{{ requesterMeta.processName || '(not provided)' }}</code></dd>
          <dt>Hostname</dt>
          <dd><code>{{ requesterMeta.hostname || '(not provided)' }}</code></dd>
          <dt>Operating system</dt>
          <dd><code>{{ requesterMeta.os || '(not provided)' }}</code></dd>
        </dl>

        <p class="warn">
          <strong>Only authorize</strong> if YOU just initiated this on a device you own and the
          process / hostname / OS above match. Authorizing grants the device
          <code>mcp.read.*</code> + <code>mcp.propose.*</code> scopes — read-only data access plus
          the ability to propose (NOT execute) trades.
        </p>
        <div class="row">
          <button
            class="btn btn-primary"
            type="button"
            data-testid="link-authorize-cta"
            @click="handleAuthorize"
          >
            Authorize with my passkey session
          </button>
          <button
            class="btn btn-ghost"
            type="button"
            data-testid="link-deny-cta"
            @click="handleDeny"
          >
            Deny
          </button>
        </div>
      </section>

      <!-- Authorizing -->
      <section v-else-if="phase === 'authorizing'" class="actions" data-testid="link-phase-authorizing">
        <p>Submitting…</p>
      </section>

      <!-- Success -->
      <section v-else-if="phase === 'success'" class="actions success" data-testid="link-phase-success">
        <h2>Linked.</h2>
        <p>
          The device above has been authorized. You can close this tab — your terminal
          should report success within a few seconds.
        </p>
      </section>

      <!-- Denied -->
      <section v-else-if="phase === 'denied'" class="actions denied" data-testid="link-phase-denied">
        <h2>Denied.</h2>
        <p>This authorization request has been recorded as denied. You can close this tab.</p>
      </section>

      <!-- Error -->
      <section v-else-if="phase === 'error'" class="actions error" data-testid="link-phase-error">
        <h2>Something went wrong.</h2>
        <p data-testid="link-error-message">{{ errorMessage }}</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.link-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.card {
  width: 100%;
  max-width: 540px;
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  border-radius: 16px;
  padding: 32px;
  background: color-mix(in srgb, currentColor 4%, transparent);
}

.card-header h1 {
  font-size: 1.5rem;
  margin: 0 0 8px;
  font-weight: 600;
}

.subtitle {
  margin: 0 0 24px;
  opacity: 0.75;
  font-size: 0.95rem;
}

.code-block {
  border-radius: 12px;
  border: 1px dashed color-mix(in srgb, currentColor 20%, transparent);
  padding: 20px;
  text-align: center;
  margin-bottom: 24px;
}

.code-block .label {
  display: block;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.6;
  margin-bottom: 8px;
}

.code-value {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 2rem;
  font-weight: 600;
  letter-spacing: 0.12em;
}

.hint {
  margin-top: 12px;
  margin-bottom: 0;
  font-size: 0.85rem;
  opacity: 0.7;
}

.actions {
  margin-top: 24px;
}

.section-h {
  font-size: 1.05rem;
  margin: 0 0 12px;
  font-weight: 600;
}

.actions.success h2,
.actions.denied h2 {
  font-size: 1.1rem;
  margin: 0 0 8px;
}

.actions.error h2 {
  font-size: 1rem;
  margin: 0 0 8px;
  color: #b00020;
}

.warn {
  background: color-mix(in srgb, gold 20%, transparent);
  border-left: 3px solid gold;
  padding: 12px 14px;
  border-radius: 6px;
  font-size: 0.9rem;
  margin: 16px 0;
}

.row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.btn {
  font-size: 0.95rem;
  padding: 12px 18px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
  font-weight: 500;
}

.btn-primary {
  background: currentColor;
  color: canvas;
}

.btn-ghost {
  background: transparent;
  border-color: color-mix(in srgb, currentColor 25%, transparent);
}

.meta-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0 0 12px;
}

.meta-list dt {
  opacity: 0.7;
  font-size: 0.85rem;
}

.meta-list dd {
  margin: 0;
  font-size: 0.9rem;
}
</style>
