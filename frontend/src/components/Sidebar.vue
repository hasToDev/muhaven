<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'
import { useAuth } from '@/composables/useAuth'
import { useHomeTarget } from '@/composables/useHomeTarget'
import { useAppVersion } from '@/composables/useAppVersion'
import { cn, formatAddress } from '@/lib/utils'
import { resolveActiveNavPath } from '@/lib/nav-active'
import MDarkToggle from '@/components/ui/MDarkToggle.vue'
import MSessionStatus from '@/components/ui/MSessionStatus.vue'
import MDevModeBanner from '@/components/ui/MDevModeBanner.vue'
import LinkTelegramModal from '@/components/agent/LinkTelegramModal.vue'
import { toast } from 'vue-sonner'
import {
  PieChart, ShoppingCart, TrendingUp, Activity, Store, Sparkles, Send, Undo2,
  Coins, Share2, Users, ClipboardCheck, Wallet, LogOut, LogIn, Loader2,
  Copy, Check, Banknote, FileSignature, CreditCard, KeyRound,
} from 'lucide-vue-next'

// Q4 (post-§4 queue) — Telegram-link modal visibility ref.
const showLinkTelegram = ref(false)

// Role is chosen at login (see LoginPage.vue). The sidebar no longer offers a
// post-login switcher — users must re-sign-in via a different role if they
// need to change. Keeping `useAuth()` imported only for logout.

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const authStore = useAuthStore()
const walletStore = useWalletStore()
const auth = useAuth()
const homeTarget = useHomeTarget()
const { fullLabel: versionLabel } = useAppVersion()

// Phase 9.A · Expansion (F2). Surface the issuer-onboarding wizard
// in the sidebar when the connected issuer hasn't finished KYB.
// Status drives both visibility and label:
//   - 'unregistered' → "Apply" + amber bloom on the row + pulsed dot
//                      (action required, this is your next step).
//   - 'pending'      → "Application" + static amber dot (informational,
//                      we're waiting on review — no action required).
//   - 'approved' / 'suspended' → item hidden (item is for "still
//                                  onboarding" states only; suspended
//                                  has no UX path in this build).
const showOnboardingNav = computed(
  () =>
    store.role === 'issuer'
    && (authStore.issuerStatus === 'unregistered' || authStore.issuerStatus === 'pending'),
)
const onboardingNavLabel = computed(() =>
  authStore.issuerStatus === 'pending' ? 'Application' : 'Apply',
)
const onboardingNavIsActionable = computed(
  () => authStore.issuerStatus === 'unregistered',
)

// Phase 9.A: Cash promoted to first nav item — it's the post-register
// landing AND the universal first-action page (USDC → mhUSDC). Portfolio
// drops to #2; remaining order unchanged.
const investorNav = [
  { path: '/cash', label: 'Cash', icon: Banknote },
  { path: '/portfolio', label: 'Portfolio', icon: PieChart },
  { path: '/marketplace', label: 'Marketplace', icon: Store },
  { path: '/trade', label: 'Trade', icon: ShoppingCart },
  { path: '/transfer', label: 'Transfer', icon: Send },
  { path: '/yields', label: 'Yields', icon: TrendingUp },
  { path: '/redemptions', label: 'Redemptions', icon: Undo2 },
  { path: '/activity', label: 'Activity', icon: Activity },
  // Wave 5 Option D · Commit 4 — agent-autonomy policy + Scoped-session
  // management (mint / manage / revoke). Penultimate, just before
  // /agent: it's the autonomy CONFIG surface that sits beside the
  // /agent chat. testid auto-derives to `sidebar-nav-policy`.
  { path: '/agent/policy/transition', label: 'Autonomy', icon: KeyRound },
  { path: '/agent', label: 'Agent', icon: Sparkles },
]

// Phase 9.A · issuer needs mhUSDC operating cash to fund distributions —
// surface /cash as the first issuer-side nav item, mirroring the
// investor side. The page is role-aware (renders an IssuerContextCard
// when role==='issuer') so the wrap mechanic stays single-source.
const issuerNav = [
  { path: '/cash', label: 'Cash', icon: Banknote },
  { path: '/tokens', label: 'Tokens', icon: Coins },
  { path: '/distribute', label: 'Distribute', icon: Share2 },
  // Wave 4 §5 Path D — hosted-checkout dashboard. Slotted between
  // Distribute and Investors because the per-buyer checkout flow is a
  // distribution surface (it's how an issuer reaches a single buyer)
  // and lives upstream of "Investors" (which is the post-onboard view).
  { path: '/checkout', label: 'Checkout', icon: CreditCard },
  { path: '/investors', label: 'Investors', icon: Users },
  { path: '/compliance', label: 'Compliance', icon: ClipboardCheck },
  // §5 walkthrough operator feedback 2026-05-1?: HavenBot supports the
  // full P7 issuer-side tool surface (distribute_yield / kyc_add /
  // kyc_remove / unpause_token / propose_create_checkout) plus the
  // P11 governance/protection reads. Pre-fix the issuer sidebar
  // omitted /agent entirely, forcing issuers to type the URL to
  // reach HavenBot. Mirrors the investor-side last-position
  // (post-Activity / post-Compliance "tools beyond the core flow").
  // Wave 5 Option D · Commit 4 — Policy is dual-role (issuers manage
  // their own agent autonomy too); mirror the investor-side penultimate
  // placement just before /agent.
  { path: '/agent/policy/transition', label: 'Autonomy', icon: KeyRound },
  { path: '/agent', label: 'Agent', icon: Sparkles },
]

const navItems = computed(() => store.role === 'investor' ? investorNav : issuerNav)

/**
 * Third-pass review (Frontend M8): nav items with sub-routes need a
 * prefix-match active state so `/checkout/:sessionId` and
 * `/checkout/webhooks` keep the "Checkout" pill highlighted. Pre-fix
 * the exact `route.path === item.path` lost orientation on detail pages.
 *
 * Wave 5 Option D · Commit 4: the new `Policy` entry (`/agent/policy/
 * transition`) is a SUB-route of the `Agent` entry (`/agent`). A naive
 * prefix-match lit BOTH pills on the Policy page. Resolve a SINGLE active
 * item by longest matching path so the most specific entry wins —
 * `/agent/policy/transition` beats `/agent`, while `/checkout` still
 * wins for `/checkout/:id` (it's the only nav item that prefixes it).
 */
const activeNavPath = computed<string | null>(() =>
  resolveActiveNavPath(navItems.value.map((i) => i.path), route.path),
)

function isNavActive(path: string): boolean {
  return activeNavPath.value === path
}

const displayAddress = computed(() => formatAddress(authStore.walletAddress))

const connectionStatus = computed(() => {
  if (walletStore.connecting) return 'connecting' as const
  if (walletStore.connected && authStore.isAuthenticated) return 'connected' as const
  if (walletStore.connected || authStore.walletAddress) return 'degraded' as const
  return 'disconnected' as const
})

function handleSignIn() {
  router.push({ path: '/login', query: { redirect: route.fullPath } })
}

async function handleLogout() {
  await auth.logout()
}

const copied = ref(false)
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

async function copyAddress() {
  const full = authStore.walletAddress
  if (!full) return
  try {
    await navigator.clipboard.writeText(full)
    copied.value = true
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => { copied.value = false }, 1500)
    toast.success('Address copied', { description: full })
  } catch (e) {
    toast.error('Copy failed', {
      description: e instanceof Error ? e.message : 'Clipboard access denied',
    })
  }
}

onBeforeUnmount(() => {
  if (copyResetTimer) clearTimeout(copyResetTimer)
})
</script>

<template>
  <aside
    class="hidden md:flex flex-col h-screen fixed left-0 top-0 w-64 z-40
           bg-white/95 dark:bg-[#0d0e10]/90 backdrop-blur-xl
           border-r border-haze dark:border-white/5
           shadow-[8px_0_40px_-20px_rgba(63,46,12,0.08)]
           dark:shadow-[8px_0_40px_-20px_rgba(0,0,0,0.6)]"
  >
    <!-- Brand -->
    <RouterLink
      :to="homeTarget"
      data-testid="nav-logo-home"
      class="px-7 pt-8 pb-10 flex flex-col gap-1.5 cursor-pointer group"
    >
      <div class="flex items-center gap-2.5">
        <img
          src="/logo.png"
          alt="MuHaven"
          class="w-9 h-9 rounded-lg transition-transform duration-300 group-hover:scale-110
                 mix-blend-multiply dark:mix-blend-normal
                 dark:drop-shadow-[0_0_12px_rgba(255,186,32,0.45)]"
        />
        <h1 class="font-sans font-bold text-2xl tracking-tight text-midnight dark:text-white">
          MuHaven
        </h1>
      </div>
      <p class="font-accent italic text-[13px] text-cool tracking-wide pl-[2.875rem] -mt-0.5">
        Confidential by design
      </p>
    </RouterLink>

    <!-- Nav items -->
    <nav class="flex-1 px-3 space-y-1 overflow-y-auto no-scrollbar">
      <!-- Phase 9.A · Expansion (F2) — issuer onboarding wizard.
           Pinned ABOVE the regular issuer nav because onboarding is
           the prerequisite gate for everything below it (Cash /
           Tokens / Distribute / etc all redirect back to
           /apply-issuer until KYB is approved). Disappears entirely
           once status flips to 'approved'.

           Visual states (post-revamp 2026-05-03):
             - on /apply-issuer → inherits the canonical active-route
               style (fully-rounded gold pill).
             - off /apply-issuer + actionable (status === 'unregistered')
               → quiet item; the only attention signal is the gold
               icon + pulsed amber dot. No bg, no ring — keeps the
               currently-active item visually unambiguous when the
               user has navigated to /cash etc.
             - off /apply-issuer + pending → identical quiet item, dot
               is static (informational, not a CTA). -->
      <RouterLink
        v-if="showOnboardingNav"
        to="/apply-issuer"
        data-testid="sidebar-nav-apply"
        :class="cn(
          'relative flex items-center gap-3 py-2.5 px-4 text-sm font-sans rounded-lg transition-colors duration-200 group',
          route.path === '/apply-issuer'
            ? 'bg-gold/12 dark:bg-signal/8 ring-1 ring-gold/35 dark:ring-signal/30 text-compute dark:text-signal font-semibold'
            : 'text-cool hover:text-midnight dark:hover:text-white hover:bg-mist/70 dark:hover:bg-white/5 font-medium',
        )"
      >
        <span class="relative inline-flex">
          <FileSignature
            :size="18"
            :stroke-width="route.path === '/apply-issuer' ? 2.2 : 1.7"
            :class="route.path === '/apply-issuer'
              ? 'text-compute dark:text-signal'
              : 'text-gold dark:text-signal'"
          />
          <!-- Status dot — amber pulse when actionable, static when
               pending. Hidden on the active route (urgency resolved). -->
          <span
            v-if="route.path !== '/apply-issuer'"
            aria-hidden="true"
            :class="cn(
              'absolute -top-0.5 -right-0.5 inline-flex h-1.5 w-1.5 rounded-full',
              onboardingNavIsActionable
                ? 'bg-gold animate-pulse'
                : 'bg-gold/70',
            )"
          />
        </span>
        <span class="tracking-wide">{{ onboardingNavLabel }}</span>
      </RouterLink>

      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        :data-testid="`sidebar-nav-${item.label.toLowerCase()}`"
        :class="cn(
          'flex items-center gap-3 py-2.5 px-4 text-sm font-sans rounded-lg transition-colors duration-200 group',
          isNavActive(item.path)
            ? 'bg-gold/12 dark:bg-signal/8 ring-1 ring-gold/35 dark:ring-signal/30 text-compute dark:text-signal font-semibold'
            : 'text-cool hover:text-midnight dark:hover:text-white hover:bg-mist/70 dark:hover:bg-white/5 font-medium',
        )"
      >
        <component
          :is="item.icon"
          :size="18"
          :stroke-width="isNavActive(item.path) ? 2.2 : 1.7"
          :class="isNavActive(item.path)
            ? 'text-compute dark:text-signal'
            : 'text-cool/80 group-hover:text-compute dark:group-hover:text-signal transition-colors'"
        />
        <span class="tracking-wide">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <!-- Bottom: dark + wallet + logout (role toggle removed — role is
         chosen at login and can't be switched post-login).
         Phase 9.C cosmetic (2026-05-04, UX triad): bottom block is now
         a "status strip" — `space-y-2` parent gap (was `space-y-3`)
         binds the rows visually as one compact info layer, matching
         the macOS-menu-bar / VS-Code-status-bar pattern. -->
    <div class="px-5 pt-5 pb-6 border-t border-haze/70 dark:border-white/5 space-y-2">
      <!-- Status strip: session pill (when active) on the left, theme
           toggle on the right. Replaces the prior "Appearance | Toggle"
           row — the standalone label was redundant against the toggle's
           sun/moon glyph, and the session pill (formerly a centered
           row of its own) now lives here as the row's natural left
           anchor. `min-h-[28px]` prevents a 1-frame collapse on first
           mount before MSessionStatus's internal `v-if="visible"`
           resolves. When the session expires (or there's no wallet),
           the toggle right-aligns alone via `justify-end` — no empty-
           label fallback (the toggle is self-explanatory). -->
      <div data-testid="nav-status-strip" class="flex items-center justify-end gap-2 px-1 min-h-[28px]">
        <MSessionStatus
          v-if="authStore.walletAddress"
          data-testid="session-status"
          class="mr-auto"
        />
        <MDarkToggle data-testid="nav-dark-toggle" />
      </div>

      <!-- Wallet pill / sign in. `py-2` (was `py-2.5`) per UX triad —
           tightens the row to ~36px so the bottom block reads as a
           dense status layer rather than three loose fragments. -->
      <div
        v-if="authStore.walletAddress"
        class="flex items-center gap-1 bg-mist dark:bg-midnight-mid/70 rounded-lg border border-haze dark:border-white/8"
      >
        <button
          type="button"
          @click="copyAddress"
          data-testid="nav-wallet-pill"
          :data-full-address="authStore.walletAddress"
          :title="copied ? 'Copied!' : `Copy ${authStore.walletAddress}`"
          :aria-label="copied ? 'Address copied to clipboard' : `Copy smart account address ${authStore.walletAddress}`"
          class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-haze/60 dark:hover:bg-white/5 transition-colors rounded-l-lg"
        >
          <span v-if="connectionStatus === 'connecting'" class="flex items-center flex-shrink-0">
            <Loader2 :size="12" class="animate-spin text-compute dark:text-signal" />
          </span>
          <span v-else class="relative flex h-2 w-2 flex-shrink-0">
            <span
              v-if="connectionStatus === 'connected'"
              class="animate-ping absolute inline-flex h-full w-full rounded-full bg-positive opacity-75"
            />
            <span
              :class="[
                'relative inline-flex rounded-full h-2 w-2',
                connectionStatus === 'connected' ? 'bg-positive' : 'bg-gold',
              ]"
            />
          </span>
          <Wallet :size="13" class="text-cool flex-shrink-0" />
          <span class="font-mono text-[11px] text-slate dark:text-body-dark truncate">
            {{ displayAddress }}
          </span>
          <Check v-if="copied" :size="11" class="text-positive flex-shrink-0" />
          <Copy v-else :size="11" class="text-cool/60 flex-shrink-0" />
        </button>
        <!-- Degraded: Sign In -->
        <button
          v-if="connectionStatus === 'degraded'"
          @click="handleSignIn"
          class="flex items-center justify-center gap-1.5 px-2.5 py-2 border-l border-haze dark:border-white/8 text-compute dark:text-signal hover:text-compute/70 dark:hover:text-signal-hover transition-colors duration-200 cursor-pointer rounded-r-lg"
          title="Session expired — sign in again"
        >
          <LogIn :size="13" />
        </button>
        <!-- Connected: Logout -->
        <button
          v-else
          @click="handleLogout"
          data-testid="nav-wallet-logout"
          class="flex items-center justify-center px-2.5 py-2 border-l border-haze dark:border-white/8 text-cool hover:text-negative transition-colors duration-200 cursor-pointer rounded-r-lg"
          title="Sign out"
        >
          <LogOut :size="13" />
        </button>
      </div>

      <!-- No wallet: Sign In -->
      <button
        v-else
        @click="handleSignIn"
        data-testid="nav-wallet-signin"
        class="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-sans font-semibold text-white dark:text-[#412d00] bg-compute dark:bg-signal hover:bg-compute-hover dark:hover:bg-signal-hover rounded-lg transition-colors duration-200 cursor-pointer shadow-[0_4px_14px_rgba(184,134,11,0.22)] dark:shadow-[0_4px_14px_rgba(255,220,161,0.2)]"
      >
        <LogIn :size="14" />
        Sign In
      </button>

      <!-- Q4 (post-§4 queue, 2026-05-14) + Plan A (2026-05-15):
           Link Telegram CTA with linked-state pill. When not linked,
           shows the prior "Link Telegram" CTA. When linked, shows a
           smaller pill `Telegram • @username` — clicking opens the
           modal in its linked-state branch (Unlink CTA). Plan A's
           `/me` short-poll auto-closes the modal on link, so the
           pill flips without operator action. -->
      <button
        v-if="authStore.walletAddress && !authStore.telegramLink?.linked"
        type="button"
        data-testid="nav-link-telegram"
        @click="showLinkTelegram = true"
        class="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium
               text-compute dark:text-signal
               border border-haze dark:border-white/10
               bg-mist/40 dark:bg-midnight-mid/40
               hover:bg-mist dark:hover:bg-midnight-mid/80
               rounded-lg transition-colors duration-150 cursor-pointer"
        title="Link your Telegram account to receive confirmation prompts"
      >
        <Send :size="13" />
        Link Telegram
      </button>
      <button
        v-else-if="authStore.walletAddress && authStore.telegramLink?.linked"
        type="button"
        data-testid="nav-telegram-linked-pill"
        @click="showLinkTelegram = true"
        class="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-[11px] font-medium
               text-compute dark:text-signal
               border border-positive/30
               bg-positive/8
               hover:bg-positive/12
               rounded-lg transition-colors duration-150 cursor-pointer"
        :title="`Linked to @${authStore.telegramLink.telegram_username ?? 'Telegram'} — click to manage`"
      >
        <Send :size="11" />
        <span class="truncate">
          Telegram · @{{ authStore.telegramLink.telegram_username ?? 'linked' }}
        </span>
      </button>

      <!-- ADR-023 dev-mode pill — bottom of the sidebar so it's always
           visible without dominating the chrome. Inherits the parent's
           `space-y-2` gap (the pre-9.C `!mt-1.5` override was undone
           because the parent gap dropped from 12px → 8px and the
           override's "tighter spacing" intent no longer applies — 6px
           override against 8px parent is a 2px delta, invisible).
           Renders nothing when devMode is off or unconfigured. -->
      <MDevModeBanner />

      <!-- Build version — whisper-quiet final inscription. Lives on its
           own line below MDevModeBanner so the just-tightened (Phase 9.C)
           wallet-pill row stays uncluttered. The dev-mode banner above
           is conditional, so this is always the last thing in the
           bottom block, providing a stable home for the operator's
           at-a-glance "which build is this?" check. -->
      <div class="flex items-center justify-end px-1 pt-1">
        <span
          data-testid="nav-app-version"
          class="font-mono text-[10px] text-cool/50 tabular-nums"
          :title="`MuHaven ${versionLabel}`"
        >{{ versionLabel }}</span>
      </div>
    </div>

    <!-- Q4 + Q5 — Telegram-link modal. Teleport to body so the modal's
         `position: fixed` resolves against the viewport regardless of
         the sidebar's transform context. -->
    <Teleport to="body">
      <LinkTelegramModal
        v-if="showLinkTelegram"
        @close="showLinkTelegram = false"
      />
    </Teleport>
  </aside>
</template>
