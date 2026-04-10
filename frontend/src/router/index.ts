import { createRouter, createWebHistory } from 'vue-router'

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
    // Investor routes
    {
      path: '/portfolio',
      component: () => import('@/views/investor/PortfolioPage.vue'),
      meta: { title: 'Portfolio' },
    },
    {
      path: '/deposit',
      component: () => import('@/views/investor/DepositPage.vue'),
      meta: { title: 'Deposit' },
    },
    {
      path: '/yields',
      component: () => import('@/views/investor/YieldsPage.vue'),
      meta: { title: 'Yields' },
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
      meta: { title: 'Agent' },
    },
  ],
})

export default router
