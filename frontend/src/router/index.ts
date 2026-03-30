import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/portfolio' },
    // Investor routes
    {
      path: '/portfolio',
      component: () => import('@/views/investor/PortfolioPage.vue'),
    },
    {
      path: '/deposit',
      component: () => import('@/views/investor/DepositPage.vue'),
    },
    {
      path: '/yields',
      component: () => import('@/views/investor/YieldsPage.vue'),
    },
    {
      path: '/activity',
      component: () => import('@/views/investor/ActivityPage.vue'),
    },
    // Issuer routes
    {
      path: '/tokens',
      component: () => import('@/views/issuer/TokensPage.vue'),
    },
    {
      path: '/distribute',
      component: () => import('@/views/issuer/DistributePage.vue'),
    },
    {
      path: '/investors',
      component: () => import('@/views/issuer/InvestorsPage.vue'),
    },
    {
      path: '/compliance',
      component: () => import('@/views/issuer/CompliancePage.vue'),
    },
  ],
})

export default router
