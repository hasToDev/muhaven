import { ref } from 'vue'
import { toast } from 'vue-sonner'
import type { ActionDescriptor } from '@/services/api'
import { useRebalance, type RebalancePlan } from '@/composables/useRebalance'
import { describeRebalancePlanShortfall, rebalanceNotices } from '@/composables/useRebalanceCopy'

/**
 * Wave 5 Slice 3 — shared "compute → propose → open modal" launcher used by
 * BOTH rebalance entry points (HavenBot chat directive in AgentPage, and the
 * Portfolio Rebalance CTA). Centralises the toast messaging + loading state so
 * the two surfaces stay consistent; the only per-surface difference is what
 * happens when legs are produced (the caller's `onLegs` opens its own
 * ConfirmModal with the hash-bound descriptor).
 */
export function useRebalanceLauncher() {
  const computing = ref(false)

  async function launch(
    walletAddress: `0x${string}` | null | undefined,
    onLegs: (descriptor: ActionDescriptor, plan: Extract<RebalancePlan, { status: 'legs' }>) => void,
  ): Promise<void> {
    if (computing.value) return
    if (!walletAddress) {
      toast.info('Sign in first', { description: 'Connect your wallet to rebalance.' })
      return
    }
    computing.value = true
    const loadingId = toast.loading('Computing your rebalance…', {
      description: 'Reading your encrypted balances and target drift.',
    })
    try {
      const { plan, descriptor } = await useRebalance().buildRebalanceProposal(walletAddress)
      toast.dismiss(loadingId)
      if (plan.status === 'legs' && descriptor) {
        // Surface excluded/truncation notices BEFORE opening the modal (the
        // "no silent caps" rule — the user sees the full picture first).
        for (const note of rebalanceNotices(plan)) {
          toast.warning('Heads up', { description: note })
        }
        onLegs(descriptor, plan)
        return
      }
      const shortfall = describeRebalancePlanShortfall(plan)
      if (shortfall) {
        const fn =
          shortfall.severity === 'success'
            ? toast.success
            : shortfall.severity === 'error'
              ? toast.error
              : toast.info
        fn(shortfall.title, { description: shortfall.description })
      }
    } catch (e) {
      toast.dismiss(loadingId)
      toast.error('Rebalance failed', {
        description: e instanceof Error ? e.message : 'Could not compute your rebalance.',
      })
    } finally {
      computing.value = false
    }
  }

  return { computing, launch }
}
