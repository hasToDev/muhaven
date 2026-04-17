import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { MotionPlugin } from '@vueuse/motion'
import App from './App.vue'
import router from './router'
import './assets/styles/global.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(MotionPlugin)

// Hydrate auth state from localStorage before first navigation.
// Wallet address is restored from localStorage (no passkey prompt).
// Wallet provider reconnects lazily via ensureConnected() on first on-chain action.
import { useAuthStore } from './stores/auth'
import { useWalletStore } from './stores/wallet'
const authStore = useAuthStore()
const hydrated = authStore.hydrate()

if (hydrated) {
  const walletStore = useWalletStore()
  walletStore.restoreAddress()
}

app.mount('#app')

// Dev-only: expose stores for console testing
if (import.meta.env.DEV) {
  import('./stores/fhe').then(({ useFheStore }) => {
    const walletStore = useWalletStore()
    ;(window as any).__wallet = walletStore
    ;(window as any).__auth = authStore
    ;(window as any).__fhe = useFheStore()
    console.log(
      '%c[MuHaven] Stores exposed: window.__wallet, window.__auth, window.__fhe',
      'color: #1B9E8A; font-weight: bold',
    )
    console.log('  __wallet.register("yourname")  — create passkey')
    console.log('  __wallet.connect()              — login with passkey')
    console.log('  __auth.isAuthenticated           — check auth status')
    console.log('  __fhe.isReady                    — FHE client ready')
  })
}
