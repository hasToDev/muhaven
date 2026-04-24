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
    // Wave 3.5 canonical: /buy drives MuHavenSubscription.purchase. /deposit
    // kept as an alias for existing bookmarks / backward compatibility.
    {
      path: '/buy',
      component: () => import('@/views/investor/BuyPage.vue'),
      meta: { title: 'Buy' },
    },
    {
      path: '/deposit',
      redirect: (to) => ({ path: '/buy', query: to.query }),
    },
    {
      path: '/wrap',
      component: () => import('@/views/investor/WrapPage.vue'),
      meta: { title: 'Wrap' },
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

// Auth guard — redirect unauthenticated users to /login
router.beforeEach((to) => {
  if (PUBLIC_ROUTES.has(to.path)) return true

  const authStore = useAuthStore()
  if (!authStore.isAuthenticated) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  return true
})

export default router
