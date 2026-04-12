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

// Hydrate auth state from localStorage before first navigation
import { useAuthStore } from './stores/auth'
import { useWalletStore } from './stores/wallet'
const authStore = useAuthStore()
const hydrated = authStore.hydrate()

app.mount('#app')

// If auth tokens were restored, reconnect wallet in the background (non-blocking)
if (hydrated) {
  const walletStore = useWalletStore()
  walletStore.tryReconnect()
}

// Dev-only: expose stores for console testing
if (import.meta.env.DEV) {
  const walletStore = useWalletStore()
  ;(window as any).__wallet = walletStore
  ;(window as any).__auth = authStore
  console.log(
    '%c[MuHaven] Stores exposed: window.__wallet, window.__auth',
    'color: #1B9E8A; font-weight: bold',
  )
  console.log('  __wallet.register("yourname")  — create passkey')
  console.log('  __wallet.connect()              — login with passkey')
  console.log('  __auth.isAuthenticated           — check auth status')
}
