/**
 * Phase 9.A · Expansion (F2) — wizard state for `/apply-issuer`.
 *
 * Two-stage shape:
 *   1. Steps 1-4 collect form data; persisted to sessionStorage so a
 *      page refresh doesn't lose progress.
 *   2. Step 5 kicks off the deploy: backend creates a `deploy_id`, the
 *      store opens an SSE channel, and `deploySteps` mirrors the
 *      progress feed. On reconnect-after-drop, `getDeploy(id)` re-
 *      hydrates `deploySteps` from the persisted row.
 *
 * Persistence is wallet-scoped (key = `muhaven:applyIssuer:draft:<addr>`).
 * sessionStorage is tab-scoped, but tabs survive logout + relogin, so a
 * prior user's KYB draft would leak to the next sign-in without this
 * scope. `tearDown()` is the logout-time aggressive sweep that wipes
 * every draft regardless of wallet.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  DEPLOY_STEPS,
  type AssetClass,
  type DeployStepKey,
  type DeployStreamEvent,
  type DeployTokenStatus,
} from '@/services/api'
import { useAuthStore } from '@/stores/auth'

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6

export interface WizardFormData {
  // Step 1 — KYB
  display_name: string
  jurisdiction: string
  contact_email: string
  // Step 2 — token basics
  symbol: string
  name: string
  asset_class: AssetClass
  // Step 3 — economics
  initial_nav: string
  min_investment: string
  yield_schedule: 'monthly' | 'quarterly' | 'annual'
}

export interface DeployStepUiState {
  key: DeployStepKey
  status: 'idle' | 'pending' | 'sent' | 'mined' | 'failed'
  txHashes: string[]
}

const STORAGE_KEY_PREFIX = 'muhaven:applyIssuer:draft'

function storageKey(walletAddress: string | null | undefined): string {
  // `:anon` covers the brief window between page-load and auth hydrate;
  // any draft saved under that key is migrated to the wallet-scoped key
  // by the next persist() once the auth store reports the address.
  if (!walletAddress) return `${STORAGE_KEY_PREFIX}:anon`
  return `${STORAGE_KEY_PREFIX}:${walletAddress.toLowerCase()}`
}

/** Sweep every wizard draft from sessionStorage. Used by `tearDown()` on
 *  logout — covers the prior wallet's draft AND any pre-fix entries that
 *  were stored under the legacy unscoped `STORAGE_KEY_PREFIX` key. */
function sweepAllDrafts(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k && (k === STORAGE_KEY_PREFIX || k.startsWith(`${STORAGE_KEY_PREFIX}:`))) {
        sessionStorage.removeItem(k)
      }
    }
  } catch {
    // sessionStorage unavailable in some private-mode browsers.
  }
}

const DEFAULT_FORM: WizardFormData = {
  display_name: '',
  jurisdiction: '',
  contact_email: '',
  symbol: '',
  name: '',
  asset_class: 'treasury',
  initial_nav: '1000000', // 1.00 USDC default
  min_investment: '1',
  yield_schedule: 'monthly',
}

export const useIssuerOnboardingStore = defineStore('issuer-onboarding', () => {
  const step = ref<WizardStep>(1)
  const formData = ref<WizardFormData>({ ...DEFAULT_FORM })
  const deployId = ref<string | null>(null)
  const deploySteps = ref<DeployStepUiState[]>(initSteps())
  const finalizeStatus = ref<'pending' | 'succeeded' | 'failed' | null>(null)
  const errorMessage = ref<string | null>(null)
  const tokenAddress = ref<string | null>(null)
  const submitting = ref(false)

  function initSteps(): DeployStepUiState[] {
    return DEPLOY_STEPS.map((key) => ({ key, status: 'idle', txHashes: [] }))
  }

  function setStep(s: WizardStep) {
    step.value = s
    persist()
  }

  function updateForm(patch: Partial<WizardFormData>) {
    formData.value = { ...formData.value, ...patch }
    persist()
  }

  function setDeployId(id: string) {
    deployId.value = id
    deploySteps.value = initSteps()
    finalizeStatus.value = null
    errorMessage.value = null
    tokenAddress.value = null
    persist()
  }

  function applyEvent(event: DeployStreamEvent) {
    if (event.step === 'finalize') {
      finalizeStatus.value = event.status === 'succeeded' ? 'succeeded' : 'failed'
      errorMessage.value = event.errorMessage ?? null
      tokenAddress.value = event.resultTokenAddress ?? null
      persist()
      return
    }

    const target = deploySteps.value.find((s) => s.key === event.step)
    if (!target) return
    target.status =
      event.status === 'pending' ? 'pending'
      : event.status === 'sent' ? 'sent'
      : event.status === 'mined' ? 'mined'
      : event.status === 'failed' ? 'failed'
      : target.status
    if (event.txHash && !target.txHashes.includes(event.txHash)) {
      target.txHashes.push(event.txHash)
    }
    persist()
  }

  function applyStatusSnapshot(status: DeployTokenStatus) {
    // Re-hydrate after an SSE drop: mark every step up to and including
    // `last_step` as mined; everything after stays idle. Terminal statuses
    // surface the result address / error.
    if (!status.last_step) {
      deploySteps.value = initSteps()
    } else {
      const lastIdx = DEPLOY_STEPS.indexOf(status.last_step)
      deploySteps.value = DEPLOY_STEPS.map((key, i) => ({
        key,
        status:
          i < lastIdx ? 'mined'
          : i === lastIdx ? (status.status === 'failed' ? 'failed' : 'mined')
          : 'idle',
        // Tx hashes aren't replayed by the row snapshot; the rail still
        // renders correctly without them.
        txHashes: [] as string[],
      }))
    }
    if (status.status === 'succeeded') {
      finalizeStatus.value = 'succeeded'
      tokenAddress.value = status.result_token_address ?? null
      errorMessage.value = null
    } else if (status.status === 'failed') {
      finalizeStatus.value = 'failed'
      errorMessage.value = status.error_message ?? 'Deploy failed'
    }
    persist()
  }

  function clearInMemory() {
    step.value = 1
    formData.value = { ...DEFAULT_FORM }
    deployId.value = null
    deploySteps.value = initSteps()
    finalizeStatus.value = null
    errorMessage.value = null
    tokenAddress.value = null
    submitting.value = false
  }

  /** Same-user reset — used by in-wizard buttons (Discard / New token /
   *  Retry). Clears in-memory state + the current wallet's draft only;
   *  other wallets' drafts in this tab are untouched. */
  function reset() {
    clearInMemory()
    try {
      const auth = useAuthStore()
      sessionStorage.removeItem(storageKey(auth.walletAddress))
    } catch {
      // Auth store unavailable (very early boot) — best-effort.
    }
  }

  /** Logout-time aggressive teardown. Wipes in-memory state + every
   *  wizard draft in sessionStorage (covers the just-logged-out user's
   *  draft AND any stale legacy-key residue from before the wallet-scope
   *  fix landed). */
  function tearDown() {
    clearInMemory()
    sweepAllDrafts()
  }

  function persist() {
    try {
      const auth = useAuthStore()
      const key = storageKey(auth.walletAddress)
      sessionStorage.setItem(
        key,
        JSON.stringify({
          // Bind the blob to the authoring wallet so a future hydrate
          // can sanity-check (mismatch = silent discard). The key
          // already encodes this; the field is defense-in-depth for
          // the rare race where authStore.walletAddress changes
          // between the key choice and the JSON write.
          walletAddress: auth.walletAddress?.toLowerCase() ?? null,
          step: step.value,
          formData: formData.value,
          deployId: deployId.value,
          finalizeStatus: finalizeStatus.value,
          tokenAddress: tokenAddress.value,
        }),
      )
    } catch {
      // sessionStorage may be unavailable in some private-mode browsers;
      // wizard still works in-memory.
    }
  }

  function hydrate(): boolean {
    // Always start from a clean baseline before overlaying the persisted
    // draft. Without this, a relogin-as-different-user scenario where
    // tokens silently expired (so `useAuth.logout()` never ran +
    // `tearDown()` was skipped) would inherit the prior user's
    // in-memory wizard state. Pinia stores live as long as the tab is
    // open; a fresh authenticated mount of /apply-issuer must look like
    // a fresh boot for the current wallet.
    clearInMemory()
    try {
      const auth = useAuthStore()
      const currentWallet = auth.walletAddress?.toLowerCase() ?? null
      // Garbage-collect the legacy unscoped key on every hydrate so
      // pre-fix data doesn't sit in storage forever. Cheap; no-op if
      // absent.
      sessionStorage.removeItem(STORAGE_KEY_PREFIX)

      const raw = sessionStorage.getItem(storageKey(currentWallet))
      if (!raw) return false
      const parsed = JSON.parse(raw)

      // Defense-in-depth: if the blob's bound wallet disagrees with
      // the current auth (shouldn't happen since the key encodes it,
      // but a manual storage-edit or a race could produce this),
      // discard silently.
      if (
        parsed?.walletAddress
        && currentWallet
        && parsed.walletAddress !== currentWallet
      ) {
        sessionStorage.removeItem(storageKey(currentWallet))
        return false
      }

      if (parsed?.step) step.value = parsed.step as WizardStep
      if (parsed?.formData) {
        formData.value = { ...DEFAULT_FORM, ...parsed.formData }
      }
      if (parsed?.deployId) deployId.value = parsed.deployId
      if (parsed?.finalizeStatus) finalizeStatus.value = parsed.finalizeStatus
      if (parsed?.tokenAddress) tokenAddress.value = parsed.tokenAddress
      return true
    } catch {
      return false
    }
  }

  const completedSteps = computed(
    () => deploySteps.value.filter((s) => s.status === 'mined').length,
  )

  return {
    // state
    step,
    formData,
    deployId,
    deploySteps,
    finalizeStatus,
    errorMessage,
    tokenAddress,
    submitting,
    // computed
    completedSteps,
    // actions
    setStep,
    updateForm,
    setDeployId,
    applyEvent,
    applyStatusSnapshot,
    reset,
    tearDown,
    hydrate,
  }
})
