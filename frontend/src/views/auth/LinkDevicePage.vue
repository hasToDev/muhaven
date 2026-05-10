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
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-vue-next'
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
    <!-- Ambient amber backdrop — pure decoration, hidden from a11y tree -->
    <div class="page-glow" aria-hidden="true">
      <div class="glow glow-amber" />
      <div class="glow glow-cipher" />
    </div>

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
          <strong>Only authorize</strong> if you started this and the device fingerprint above is yours.
        </p>
        <p class="scopes">
          Grants <code>mcp.read.*</code> + <code>mcp.propose.*</code> — read-only data plus action proposals (no auto-execution).
        </p>
        <div class="row">
          <button
            class="btn btn-primary"
            type="button"
            data-testid="link-authorize-cta"
            @click="handleAuthorize"
          >
            Authorize
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
      <section v-else-if="phase === 'success'" class="actions terminal success" data-testid="link-phase-success">
        <div class="terminal-icon" aria-hidden="true">
          <CheckCircle2 :size="44" :stroke-width="1.75" />
        </div>
        <h2>Device linked</h2>
        <p>
          The device above has been authorized. You can close this tab — your terminal
          will report success within a few seconds.
        </p>
      </section>

      <!-- Denied -->
      <section v-else-if="phase === 'denied'" class="actions terminal denied" data-testid="link-phase-denied">
        <div class="terminal-icon" aria-hidden="true">
          <XCircle :size="44" :stroke-width="1.75" />
        </div>
        <h2>Request denied</h2>
        <p>This authorization request has been recorded as denied. You can close this tab.</p>
      </section>

      <!-- Error -->
      <section v-else-if="phase === 'error'" class="actions terminal error" data-testid="link-phase-error">
        <div class="terminal-icon" aria-hidden="true">
          <AlertTriangle :size="44" :stroke-width="1.75" />
        </div>
        <h2>Something went wrong</h2>
        <p data-testid="link-error-message">{{ errorMessage }}</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.link-page {
  position: relative;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  isolation: isolate;
}

/* Ambient amber bloom — purely decorative; canvas behind the card. */
.page-glow {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  overflow: hidden;
}

.glow {
  position: absolute;
  border-radius: 9999px;
  filter: blur(120px);
  opacity: 0.55;
}

.glow-amber {
  width: 640px;
  height: 640px;
  top: -180px;
  left: 50%;
  transform: translateX(-50%);
  background: radial-gradient(circle, rgba(255, 186, 32, 0.22) 0%, rgba(184, 134, 11, 0.06) 55%, transparent 75%);
}

.glow-cipher {
  width: 480px;
  height: 480px;
  bottom: -160px;
  right: -120px;
  background: radial-gradient(circle, rgba(255, 220, 161, 0.16) 0%, transparent 70%);
}

.card {
  position: relative;
  width: 100%;
  max-width: 540px;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 18px;
  padding: 32px;
  background:
    linear-gradient(
      180deg,
      rgba(255, 186, 32, 0.04) 0%,
      rgba(28, 29, 32, 0.6) 30%,
      rgba(28, 29, 32, 0.7) 100%
    ),
    var(--color-surface, rgba(28, 29, 32, 0.85));
  box-shadow:
    0 24px 70px rgba(0, 0, 0, 0.45),
    0 1px 0 rgba(255, 186, 32, 0.08) inset,
    0 -1px 0 rgba(0, 0, 0, 0.3) inset;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.card-header h1 {
  font-size: 1.5rem;
  margin: 0 0 8px;
  font-weight: 600;
}

.subtitle {
  margin: 0 0 24px;
  color: var(--color-text-muted, #b3a98e);
  font-size: 0.95rem;
}

.code-block {
  border-radius: 12px;
  border: 1px dashed var(--color-border, rgba(255, 255, 255, 0.12));
  padding: 20px;
  text-align: center;
  margin-bottom: 24px;
}

.code-block .label {
  display: block;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted, #b3a98e);
  margin-bottom: 8px;
}

.code-value {
  font-family: 'DM Mono', 'JetBrains Mono', ui-monospace, monospace;
  font-size: 2rem;
  font-weight: 600;
  letter-spacing: 0.12em;
}

.hint {
  margin-top: 12px;
  margin-bottom: 0;
  font-size: 0.85rem;
  color: var(--color-text-muted, #b3a98e);
}

.actions {
  margin-top: 24px;
}

.section-h {
  font-size: 1.05rem;
  margin: 0 0 12px;
  font-weight: 600;
}

/* Terminal states (success / denied / error) — center-stack the icon, headline, and copy
   so the result reads as a single moment, not as continuation of the form. */
.terminal {
  text-align: center;
  padding: 16px 8px 8px;
  animation: terminal-rise 320ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.terminal h2 {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 8px 0 10px;
  letter-spacing: -0.01em;
}

.terminal p {
  font-size: 0.95rem;
  color: var(--color-text-muted, #b3a98e);
  line-height: 1.55;
  margin: 0 auto;
  max-width: 38ch;
}

.terminal-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  border-radius: 9999px;
  margin-bottom: 4px;
}

.terminal.success .terminal-icon {
  color: #4ade80;
  background: radial-gradient(circle, rgba(74, 222, 128, 0.18) 0%, rgba(74, 222, 128, 0.04) 60%, transparent 80%);
  box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.25), 0 12px 30px rgba(74, 222, 128, 0.18);
}

.terminal.success h2 {
  color: #4ade80;
}

.terminal.denied .terminal-icon {
  color: #fca5a5;
  background: radial-gradient(circle, rgba(252, 165, 165, 0.16) 0%, rgba(252, 165, 165, 0.04) 60%, transparent 80%);
  box-shadow: 0 0 0 1px rgba(252, 165, 165, 0.22), 0 12px 30px rgba(252, 165, 165, 0.14);
}

.terminal.denied h2 {
  color: #fca5a5;
}

.terminal.error .terminal-icon {
  color: #f87171;
  background: radial-gradient(circle, rgba(248, 113, 113, 0.18) 0%, rgba(248, 113, 113, 0.04) 60%, transparent 80%);
  box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.25), 0 12px 30px rgba(248, 113, 113, 0.18);
}

.terminal.error h2 {
  color: #f87171;
  font-size: 1.35rem;
}

@keyframes terminal-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .terminal {
    animation: none;
  }
}

.warn {
  background: rgba(184, 134, 11, 0.12);
  border-left: 3px solid #b8860b;
  padding: 12px 14px;
  border-radius: 6px;
  font-size: 0.9rem;
  margin: 16px 0 8px;
}

.scopes {
  margin: 0 0 16px;
  font-size: 0.8rem;
  color: var(--color-text-muted, #b3a98e);
  line-height: 1.5;
}

.scopes code {
  font-size: 0.78rem;
}

.row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.btn {
  flex: 1;
  font-size: 0.95rem;
  padding: 12px 18px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
  font-weight: 600;
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

.meta-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0 0 12px;
}

.meta-list dt {
  color: var(--color-text-muted, #b3a98e);
  font-size: 0.85rem;
}

.meta-list dd {
  margin: 0;
  font-size: 0.9rem;
}

.meta-list code,
.code-block code {
  font-family: 'DM Mono', 'JetBrains Mono', ui-monospace, monospace;
}
</style>
