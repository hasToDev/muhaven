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
app.mount('#app')

// Dev-only: expose wallet store for console testing
if (import.meta.env.DEV) {
  import('./stores/wallet').then(({ useWalletStore }) => {
    ;(window as any).__wallet = useWalletStore()
    console.log(
      '%c[MuHaven] Wallet store exposed as window.__wallet',
      'color: #1B9E8A; font-weight: bold',
    )
    console.log('  __wallet.register("yourname")  — create passkey')
    console.log('  __wallet.connect()              — login with passkey')
    console.log('  __wallet.address                — current address')
    console.log('  __wallet.disconnect()           — disconnect')
  })
}
