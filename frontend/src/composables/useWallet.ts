import { storeToRefs } from 'pinia'
import { useWalletStore } from '@/stores/wallet'

/**
 * Composable wrapping the wallet Pinia store.
 * Returns reactive refs for template binding + action methods.
 */
export function useWallet() {
  const store = useWalletStore()
  const { address, connecting, connected, error } = storeToRefs(store)

  return {
    // reactive state
    address,
    connecting,
    connected,
    error,
    // actions
    connect: store.connect,
    register: store.register,
    disconnect: store.disconnect,
    signMessage: store.signMessage,
    sendUserOperation: store.sendUserOperation,
    getViemClients: store.getViemClients,
    tryReconnect: store.tryReconnect,
  }
}
