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

// Wave 6 Polish (A2) — make `v-motion` honor `prefers-reduced-motion`.
// @vueuse/motion v3's directive runs a Popmotion requestAnimationFrame loop
// and never consults the reduced-motion media query (the CSS animations are
// already gated in global.css; the JS ones were the gap). For reduced-motion
// users we replace the `motion` directive — registered AFTER MotionPlugin so
// it wins — with a zero-animation version that simply snaps each element to
// its final resting variant. The library directive never runs, so the
// `:initial` (opacity:0) hidden state is never applied → content is always
// visible. We only read `enter`/`visible(-once)` opacity and never touch
// `transform`, so no existing CSS transform is clobbered. Gated strictly to
// reduce-only: the default brand experience is byte-for-byte unchanged. See
// development/DEV_WAVE_6_POLISH/ADR_LOG.md ADR-002.
if (
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches
) {
  app.directive('motion', {
    mounted(el: HTMLElement, _binding, vnode) {
      const props = (vnode?.props ?? {}) as Record<string, any>
      const final =
        props.enter ?? props.visible ?? props['visible-once'] ?? props.visibleOnce ?? null
      if (final && typeof final.opacity === 'number') {
        el.style.opacity = String(final.opacity)
      }
    },
  })
}

// Hydrate auth state from localStorage and kick off `/users/me` for
// `issuerStatus` (Phase 9.A · Expansion F2). Wallet address is
// restored from localStorage without prompting; the wallet provider
// reconnects lazily via `ensureConnected()` on first on-chain action.
//
// We hydrate synchronously here (don't use `useAuth.initialize()`,
// which needs `useRouter()` and therefore a component context) and
// kick off `fetchUserMeta()` without blocking mount. The router's
// `beforeEach` awaits the same in-flight promise so the first guarded
// navigation never renders before /me resolves.
import { useAuthStore } from './stores/auth'
import { useWalletStore } from './stores/wallet'
import { useAppStore } from './stores/app'

const authStore = useAuthStore()
const hydrated = authStore.hydrate()

if (hydrated) {
  const walletStore = useWalletStore()
  walletStore.restoreAddress()
  // Phase 9.A · role guardrail. Mirror the JWT-derived role into the
  // app store so the navigation chrome renders the correct role on
  // the very first paint. Without this `appStore.role` defaults to
  // 'investor' and the sidebar would briefly show investor nav for an
  // issuer reload.
  if (authStore.role) useAppStore().setRole(authStore.role)
  // Fire-and-forget: the router guard awaits the same promise via
  // `authStore.fetchUserMeta()` (idempotent — concurrent callers share
  // the in-flight promise).
  void authStore.fetchUserMeta()
}

app.mount('#app')

// Temporary mobile overflow detector — inert unless the URL has `?ofx=1`.
// Diagnosing the recurring Portfolio reveal-time horizontal scroll. Remove
// once the culprit is found + fixed. See lib/overflowDebug.ts.
import('./lib/overflowDebug').then((m) => m.installOverflowDebug())

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
