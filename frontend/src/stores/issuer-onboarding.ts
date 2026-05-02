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
 * SessionStorage scope intentional: localStorage would survive logout
 * + cross-tab, which is wrong for a form that captures KYB data.
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

const STORAGE_KEY = 'muhaven:applyIssuer:draft'

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

  function reset() {
    step.value = 1
    formData.value = { ...DEFAULT_FORM }
    deployId.value = null
    deploySteps.value = initSteps()
    finalizeStatus.value = null
    errorMessage.value = null
    tokenAddress.value = null
    submitting.value = false
    sessionStorage.removeItem(STORAGE_KEY)
  }

  function persist() {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
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
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      if (!raw) return false
      const parsed = JSON.parse(raw)
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
    hydrate,
  }
})
