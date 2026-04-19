<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import { useAppStore } from '@/stores/app'
import { useMarketplaceStore } from '@/stores/marketplace'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import * as TokenService from '@/services/contracts/TokenService'
import * as VaultService from '@/services/contracts/VaultService'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import { addresses } from '@/contracts/addresses'
import { portfolioApi, type TokenResponseDto } from '@/services/api'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MStepProgress from '@/components/ui/MStepProgress.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import MFundAccount from '@/components/ui/MFundAccount.vue'
import MPrivacyProofPanel, { type ProofIntent } from '@/components/ui/MPrivacyProofPanel.vue'
import { CheckCircle, Lock, Shield, Eye } from 'lucide-vue-next'
import { formatUSD } from '@/lib/utils'

const route = useRoute()
const app = useAppStore()
const marketplace = useMarketplaceStore()
const { address } = useWallet()
const { encryptUint128 } = useFhe()

// ── State ──────────────────────────────────────────────────────────

type DepositPath = 'encrypted-mint' | 'vault-wrap'
const depositPath = ref<DepositPath>('encrypted-mint')
const selectedToken = ref<string>('')
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)
const txHash = ref<string | null>(null)
const txIntent = ref<ProofIntent | null>(null)
const error = ref<string | null>(null)

const stepsEncrypted = [
  { label: 'Enter Amount', description: 'Choose deposit amount' },
  { label: 'Encrypt', description: 'Client-side FHE encryption' },
  { label: 'Submit', description: 'Sending encrypted transaction' },
]

const stepsVaultWrap = [
  { label: 'Enter Amount', description: 'Choose wrap amount' },
  { label: 'Approve', description: 'Approve ERC-20 to vault' },
  { label: 'Wrap', description: 'Wrap into fhERC-20' },
]

const steps = computed(() => depositPath.value === 'encrypted-mint' ? stepsEncrypted : stepsVaultWrap)

const quickAmounts = ['100', '1000', '5000']

const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)

const selectedTokenData = computed<TokenResponseDto | undefined>(() =>
  selectedToken.value ? marketplace.getByAddress(selectedToken.value) : undefined,
)

const estimatedYield = computed(() => {
  const apy = selectedTokenData.value?.apy ? parseFloat(selectedTokenData.value.apy) : 4.8
  return (numericAmount.value * apy / 100 / 12).toFixed(2)
})

onMounted(async () => {
  if (!marketplace.loaded) {
    await marketplace.load()
  }
  // Pre-select from query param (?token=0x...) or default to first active token
  const queryToken = route.query.token as string | undefined
  if (queryToken && marketplace.getByAddress(queryToken)) {
    selectedToken.value = queryToken
  } else if (marketplace.filtered.length > 0 && !selectedToken.value) {
    selectedToken.value = marketplace.filtered[0].address
  }
})

// ── Deposit handlers ───────────────────────────────────────────────

async function handleEncryptedMint() {
  if (!amount.value || isProcessing.value || !address.value) return
  isProcessing.value = true
  error.value = null

  try {
    // Step 1: Encrypt
    currentStep.value = 1
    const amountWei = BigInt(Math.floor(numericAmount.value * 1e18))
    const encrypted = await encryptUint128(amountWei)

    // Step 2: Submit encrypted mint
    currentStep.value = 2
    const hash = await TokenService.mint(
      address.value as `0x${string}`,
      encrypted as any,
    )

    txHash.value = hash
    // Snapshot the inner call we just submitted so the privacy-proof panel
    // can render it. We can't recover this from `tx.input` because ZeroDev
    // wraps everything in handleOps([...]).
    txIntent.value = {
      contract: 'MuHavenToken',
      functionName: 'mint',
      args: [address.value, encrypted],
    }
    currentStep.value = 3
    showSuccess.value = true
    toast.success('Deposit confirmed', {
      description: `Encrypted mint submitted — amount never appeared in cleartext`,
    })

    // Register position in backend portfolio
    if (selectedTokenData.value) {
      portfolioApi.addPosition(selectedTokenData.value.address, selectedTokenData.value.symbol).catch(() => {})
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Deposit failed'
    toast.error('Deposit failed', { description: error.value })
  } finally {
    isProcessing.value = false
  }
}

async function handleVaultWrap() {
  if (!amount.value || isProcessing.value || !address.value) return
  isProcessing.value = true
  error.value = null

  try {
    const amountWei = BigInt(Math.floor(numericAmount.value * 1e18))

    // Step 1: Approve ERC-20 to vault
    currentStep.value = 1
    const underlying = await VaultService.underlyingToken()
    await Erc20Service.approve(underlying, addresses.muHavenVault, amountWei)

    // Step 2: Wrap
    currentStep.value = 2
    const hash = await VaultService.wrap(amountWei)

    txHash.value = hash
    // Intent reflects the wrap call only (the approve was a separate userOp
    // with its own hash that we don't surface).
    txIntent.value = {
      contract: 'MuHavenVault',
      functionName: 'wrap',
      args: [amountWei],
    }
    currentStep.value = 3
    showSuccess.value = true
    toast.success('Wrap confirmed', {
      description: `ERC-20 wrapped into fhERC-20 — balance now encrypted on-chain`,
    })

    // Register position in backend portfolio
    if (selectedTokenData.value) {
      portfolioApi.addPosition(selectedTokenData.value.address, selectedTokenData.value.symbol).catch(() => {})
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Wrap failed'
    toast.error('Wrap failed', { description: error.value })
  } finally {
    isProcessing.value = false
  }
}

function handleDeposit() {
  if (depositPath.value === 'encrypted-mint') {
    handleEncryptedMint()
  } else {
    handleVaultWrap()
  }
}

function resetForm() {
  currentStep.value = 0
  amount.value = ''
  showSuccess.value = false
  txHash.value = null
  txIntent.value = null
  error.value = null
}
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="app.isLoading" class="max-w-2xl mx-auto flex flex-col gap-8">
    <MSkeleton variant="title" width="200px" />
    <MSkeleton variant="card" height="360px" />
  </div>

  <!-- Content -->
  <div v-else class="max-w-2xl mx-auto flex flex-col gap-8">
    <div
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white tracking-tight">Deposit</h1>
      <MGoldRule />
    </div>

    <!-- Fund your account -->
    <MFundAccount />

    <!-- Deposit path selector -->
    <div class="flex gap-3">
      <button
        @click="depositPath = 'encrypted-mint'"
        data-testid="deposit-path-encrypted"
        :class="[
          'flex-1 px-4 py-3 rounded-xl border text-left transition-all duration-200',
          depositPath === 'encrypted-mint'
            ? 'border-compute bg-compute/5 ring-2 ring-compute/20'
            : 'border-haze dark:border-white/10 hover:border-compute/30',
        ]"
      >
        <div class="flex items-center gap-2 mb-1">
          <Lock :size="14" class="text-compute" />
          <span class="text-sm font-medium text-midnight dark:text-white">Encrypted Mint</span>
        </div>
        <p class="text-xs text-cool">Client-side encryption — amount never in cleartext on-chain</p>
        <MBadge variant="privacy" class="mt-2">Best Privacy</MBadge>
      </button>

      <button
        @click="depositPath = 'vault-wrap'"
        data-testid="deposit-path-wrap"
        :class="[
          'flex-1 px-4 py-3 rounded-xl border text-left transition-all duration-200',
          depositPath === 'vault-wrap'
            ? 'border-compute bg-compute/5 ring-2 ring-compute/20'
            : 'border-haze dark:border-white/10 hover:border-compute/30',
        ]"
      >
        <div class="flex items-center gap-2 mb-1">
          <Shield :size="14" class="text-gold" />
          <span class="text-sm font-medium text-midnight dark:text-white">Vault Wrap</span>
        </div>
        <p class="text-xs text-cool">Wrap existing ERC-20 RWA into fhERC-20 — amount visible until wrap</p>
        <MBadge variant="gold" class="mt-2">For ERC-20 Tokens</MBadge>
      </button>
    </div>

    <!-- Token selector -->
    <div v-if="marketplace.filtered.length > 0">
      <label class="text-xs uppercase tracking-wider text-cool font-sans font-medium">Token</label>
      <select
        v-model="selectedToken"
        :disabled="isProcessing"
        data-testid="deposit-token-select"
        class="mt-2 w-full py-3 px-4 text-sm font-sans border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white focus:outline-none focus:border-compute focus:ring-2 focus:ring-compute/20 transition-colors disabled:opacity-50"
      >
        <option v-for="t in marketplace.filtered" :key="t.address" :value="t.address">
          {{ t.name }} ({{ t.symbol }}) — {{ t.apy ? `${t.apy}% APY` : 'N/A' }}
        </option>
      </select>
    </div>

    <div class="px-4 pb-2">
      <MStepProgress :steps="steps" :current-step="currentStep" />
    </div>

    <MCard
      padding="lg"
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 150 } }"
    >
      <!-- Success state -->
      <div v-if="showSuccess" data-testid="deposit-success-card" class="flex flex-col items-center gap-4 py-8">
        <div
          v-motion
          :initial="{ opacity: 0, scale: 0.5 }"
          :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
          class="w-16 h-16 rounded-full bg-compute/12 flex items-center justify-center"
        >
          <CheckCircle :size="32" class="text-compute" />
        </div>
        <p class="text-lg font-sans font-semibold text-midnight dark:text-white">
          {{ depositPath === 'encrypted-mint' ? 'Encrypted Deposit Confirmed' : 'Vault Wrap Confirmed' }}
        </p>
        <p class="text-sm text-cool">
          {{ depositPath === 'encrypted-mint'
            ? 'Amount was encrypted client-side — never visible on-chain'
            : 'ERC-20 wrapped into fhERC-20 — balance now encrypted'
          }}
        </p>
        <p v-if="txHash" class="text-xs font-mono text-cool">
          tx: <a :href="`https://sepolia.arbiscan.io/tx/${txHash}`" target="_blank" rel="noopener" class="text-compute hover:underline">{{ txHash.slice(0, 10) }}...{{ txHash.slice(-8) }}</a>
        </p>

        <!-- Privacy proof — split view of what Arbiscan sees vs. what you see -->
        <MPrivacyProofPanel
          v-if="txHash"
          :tx-hash="txHash"
          :intent="txIntent ?? undefined"
          :default-open="true"
          class="w-full mt-2"
        />

        <MButton variant="outline" @click="resetForm">Make Another Deposit</MButton>
      </div>

      <!-- Error state -->
      <div v-else-if="error" data-testid="deposit-error-card" class="flex flex-col items-center gap-4 py-8">
        <p class="text-base text-cool">{{ error }}</p>
        <MButton variant="outline" @click="resetForm">Try Again</MButton>
      </div>

      <!-- Form -->
      <template v-else>
        <label class="text-xs uppercase tracking-wider text-cool font-sans font-medium">Amount</label>

        <!-- Quick amount buttons -->
        <div class="flex gap-2 mt-2 mb-3">
          <button
            v-for="qa in quickAmounts"
            :key="qa"
            @click="amount = qa"
            :disabled="isProcessing"
            :data-testid="`deposit-quick-${qa}`"
            class="px-3 py-1.5 text-xs font-medium border border-haze dark:border-white/10 rounded-lg text-cool hover:text-compute hover:border-compute/30 transition-all duration-200 cursor-pointer disabled:opacity-50"
          >
            ${{ Number(qa).toLocaleString() }}
          </button>
        </div>

        <div class="flex gap-2.5 mb-4">
          <div class="flex-1 relative">
            <span class="absolute left-4 top-1/2 -translate-y-1/2 text-lg text-cool">$</span>
            <input
              v-model="amount"
              placeholder="0.00"
              :disabled="isProcessing"
              data-testid="deposit-amount-input"
              class="w-full py-3.5 pl-8 pr-4 text-lg font-mono border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white placeholder:text-cool focus:outline-none focus:border-compute focus:ring-2 focus:ring-compute/20 transition-colors disabled:opacity-50"
            />
          </div>
        </div>

        <!-- Estimated yield -->
        <div v-if="numericAmount > 0" class="mb-6 bg-compute/5 border border-compute/15 rounded-lg px-4 py-3 flex items-center justify-between">
          <span class="text-xs text-slate dark:text-cool">
            Est. monthly yield at {{ selectedTokenData?.apy || '4.8' }}% APY
          </span>
          <span class="text-sm font-mono font-medium text-compute">${{ estimatedYield }}</span>
        </div>
        <div v-else class="mb-6" />

        <!-- Privacy indicator -->
        <div class="mb-4 p-3 rounded-lg border" :class="depositPath === 'encrypted-mint' ? 'border-compute/20 bg-compute/5' : 'border-gold/20 bg-gold/5'">
          <div class="flex items-center gap-2">
            <Eye :size="14" :class="depositPath === 'encrypted-mint' ? 'text-compute' : 'text-gold'" />
            <span class="text-xs font-medium" :class="depositPath === 'encrypted-mint' ? 'text-compute' : 'text-gold'">
              {{ depositPath === 'encrypted-mint' ? 'Privacy: Maximum' : 'Privacy: After Wrap' }}
            </span>
          </div>
          <p class="text-xs text-cool mt-1">
            {{ depositPath === 'encrypted-mint'
              ? 'Amount encrypted client-side before submission. Never appears in cleartext on-chain.'
              : 'ERC-20 approval and wrap amounts are visible on-chain. Balance becomes encrypted after wrapping.'
            }}
          </p>
        </div>

        <MButton
          variant="primary"
          full-width
          size="lg"
          data-testid="deposit-cta"
          :loading="isProcessing"
          :disabled="!amount.trim() || numericAmount <= 0"
          @click="handleDeposit"
        >
          {{ depositPath === 'encrypted-mint' ? 'Encrypt & Deposit' : 'Approve & Wrap' }}
        </MButton>

        <div class="mt-5">
          <MPrivacyBanner
            :text="depositPath === 'encrypted-mint'
              ? 'Amount will be encrypted client-side via Fhenix FHE before submission. The chain never sees the cleartext.'
              : 'Wrap amount is visible until it enters the vault. After wrapping, your fhERC-20 balance is FHE-encrypted.'"
          />
        </div>
      </template>
    </MCard>
  </div>
  </div>
</template>
