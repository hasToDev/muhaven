import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const PUBLIC_ROUTES = new Set(['/', '/login'])

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior() {
    return { top: 0 }
  },
  routes: [
    {
      path: '/',
      component: () => import('@/views/LandingPage.vue'),
      meta: { title: 'Home', layout: 'landing' },
    },
    {
      path: '/login',
      component: () => import('@/views/LoginPage.vue'),
      meta: { title: 'Sign In', layout: 'login' },
    },
    // Investor routes
    {
      path: '/portfolio',
      component: () => import('@/views/investor/PortfolioPage.vue'),
      meta: { title: 'Portfolio' },
    },
    {
      path: '/marketplace',
      component: () => import('@/views/investor/MarketplacePage.vue'),
      meta: { title: 'Marketplace' },
    },
    // Wave 3.5 canonical: /trade is a single page with a Buy/Sell mode
    // toggle (Phase 6.5) — `MuHavenSubscription.purchase` for buy,
    // `MuHavenSubscription.redeem` for sell with auto-escalate-to-queue
    // when the instant cap is full. /buy + /deposit kept as aliases for
    // existing bookmarks; /buy?mode=sell deep-links straight into Sell.
    {
      path: '/trade',
      component: () => import('@/views/investor/TradePage.vue'),
      meta: { title: 'Trade' },
    },
    {
      path: '/buy',
      redirect: (to) => ({ path: '/trade', query: to.query }),
    },
    {
      path: '/deposit',
      redirect: (to) => ({ path: '/trade', query: to.query }),
    },
    {
      path: '/cash',
      component: () => import('@/views/investor/CashPage.vue'),
      meta: { title: 'Cash' },
    },
    // Phase 9.A: /wrap renamed to /cash. Keep the old path as a redirect
    // for any internal link / bookmark / doc that still says /wrap so we
    // don't ship dead URLs. Query params (e.g. ?mode=asset) are preserved.
    {
      path: '/wrap',
      redirect: (to) => ({ path: '/cash', query: to.query }),
    },
    {
      path: '/transfer',
      component: () => import('@/views/investor/TransferPage.vue'),
      meta: { title: 'Transfer' },
    },
    {
      path: '/yields',
      component: () => import('@/views/investor/YieldsPage.vue'),
      meta: { title: 'Yields' },
    },
    {
      path: '/redemptions',
      component: () => import('@/views/investor/RedemptionsPage.vue'),
      meta: { title: 'Redemptions' },
    },
    {
      path: '/activity',
      component: () => import('@/views/investor/ActivityPage.vue'),
      meta: { title: 'Activity' },
    },
    // Issuer routes
    {
      path: '/tokens',
      component: () => import('@/views/issuer/TokensPage.vue'),
      meta: { title: 'Tokens' },
    },
    // Phase 9.A · Expansion (F2) — self-serve issuer onboarding wizard.
    // Auth-gated but role-agnostic: an unregistered investor can apply,
    // and an approved issuer hits the redirect-out branch in
    // ApplyPage.onMounted to bounce to /tokens. The route is excluded
    // from `ISSUER_ROUTES` so investors can navigate here without the
    // role-guardrail kicking them back to /portfolio.
    {
      path: '/apply-issuer',
      component: () => import('@/views/issuer/ApplyPage.vue'),
      meta: { title: 'Become an Issuer', layout: 'apply' },
    },
    {
      path: '/distribute',
      component: () => import('@/views/issuer/DistributePage.vue'),
      meta: { title: 'Distribute' },
    },
    {
      path: '/investors',
      component: () => import('@/views/issuer/InvestorsPage.vue'),
      meta: { title: 'Investors' },
    },
    {
      path: '/compliance',
      component: () => import('@/views/issuer/CompliancePage.vue'),
      meta: { title: 'Compliance' },
    },
    // Agent route (Layer 3)
    {
      path: '/agent',
      component: () => import('@/views/AgentPage.vue'),
      // `layout: 'agent'` tells App.vue to use a tighter wrapper pb so the
      // chat container can fill the viewport vertically and the input bar
      // sits anchored just above the viewport bottom (no page scroll).
      meta: { title: 'Agent', layout: 'agent' },
    },
  ],
})

// Phase 9.A · role guardrail. Routes are bucketed by role so an
// authenticated user can't accidentally land on the other side via a
// pasted URL or a stale link. `/cash` and `/agent` stay dual-role
// (cash conversion is the same mechanic for both; agent surfaces will
// gate per-role internally in Wave 4).
const ISSUER_ROUTES = new Set(['/tokens', '/distribute', '/investors', '/compliance'])
const INVESTOR_ROUTES = new Set([
  '/portfolio',
  '/marketplace',
  '/trade',
  '/transfer',
  '/yields',
  '/redemptions',
  '/activity',
])

// Auth guard — redirect unauthenticated users to /login
router.beforeEach((to) => {
  if (PUBLIC_ROUTES.has(to.path)) return true

  const authStore = useAuthStore()
  if (!authStore.isAuthenticated) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  // Role-aware redirect: issuers lose access to investor surfaces and
  // vice versa. Backend ROLE_MISMATCH is the source of truth on login;
  // this guard prevents an in-session navigation typo from rendering
  // a page that wouldn't have data for the wrong role.
  const role = authStore.role
  if (role === 'investor' && ISSUER_ROUTES.has(to.path)) {
    return { path: '/portfolio' }
  }
  if (role === 'issuer' && INVESTOR_ROUTES.has(to.path)) {
    return { path: '/tokens' }
  }

  return true
})

export default router
