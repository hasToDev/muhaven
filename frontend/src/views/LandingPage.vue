<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useTypewriter } from '@/composables/useTypewriter'
import { useCountUp } from '@/composables/useCountUp'
import { cn } from '@/lib/utils'
import { useAppVersion } from '@/composables/useAppVersion'

import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MAccordion from '@/components/ui/MAccordion.vue'
import MDarkToggle from '@/components/ui/MDarkToggle.vue'

import {
  Shield, TrendingUp, Zap, Lock,
  ArrowRight, Github, ExternalLink, Eye, EyeOff,
  ChevronDown, FileCode, ShieldCheck, Bot, Menu, X,
} from 'lucide-vue-next'

import {
  LANDING_STATS, LANDING_FEATURES, LANDING_FAQ, LANDING_CODE_LINES, LANDING_AI_PREVIEW,
} from '@/data/constants'

const router = useRouter()
const { fullLabel: versionLabel } = useAppVersion()

const { displayed: heroLine1, isDone: line1Done, target: heroRef } = useTypewriter('Private', 50, 800)
const heroLine2 = ref('')
const line2Done = ref(false)
const heroLine3 = ref('')
const line3Done = ref(false)

function chainTypewriter(text: string, target: typeof heroLine2, done: typeof line2Done, speed = 50) {
  let i = 0
  const timer = setInterval(() => {
    if (i < text.length) {
      target.value = text.slice(0, i + 1)
      i++
    } else {
      clearInterval(timer)
      done.value = true
    }
  }, speed)
}

// Chain: "Private" → "Portfolios." → "AI-Managed."
watch(line1Done, (v) => { if (v) chainTypewriter('Portfolios.', heroLine2, line2Done) })
watch(line2Done, (v) => { if (v) chainTypewriter('AI-Managed.', heroLine3, line3Done) })

const stat0 = useCountUp(LANDING_STATS[0].value, 1800, 0)
const stat1 = useCountUp(LANDING_STATS[1].value, 1800, 0)
const stat2 = useCountUp(LANDING_STATS[2].value, 1800, 0)
const stat3 = useCountUp(LANDING_STATS[3].value, 1200, 0)
const statRefs = [stat0, stat1, stat2, stat3]
const statIcons = [FileCode, ShieldCheck, Bot, EyeOff]
const featureIcons = { Shield, TrendingUp, Zap } as Record<string, any>

const mobileMenuOpen = ref(false)
const mobileMenuFirstLink = ref<HTMLAnchorElement | null>(null)
const showStickyCTA = ref(false)
function onScroll() { showStickyCTA.value = window.scrollY > window.innerHeight * 0.9 }
function onKeyDown(e: KeyboardEvent) {
  if (mobileMenuOpen.value && e.key === 'Escape') {
    mobileMenuOpen.value = false
  }
}
watch(mobileMenuOpen, (open) => {
  if (open) nextTick(() => mobileMenuFirstLink.value?.focus())
})
onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('keydown', onKeyDown)
})
onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('keydown', onKeyDown)
})

const featuresSection = ref<HTMLElement | null>(null)
function scrollToFeatures() { featuresSection.value?.scrollIntoView({ behavior: 'smooth' }) }
function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }) }

const ARBISCAN_SUBSCRIPTION_URL = 'https://sepolia.arbiscan.io/address/0x39D49B2614d24ba189B613bEAa903d829A73eA9e'
function openArbiscan() { window.open(ARBISCAN_SUBSCRIPTION_URL, '_blank', 'noopener,noreferrer') }
function goToIssuerOnboarding() { router.push('/apply-issuer') }

const navLinks = [
  { name: 'Features', href: '#features' },
  { name: 'How It Works', href: '#how-it-works' },
  { name: 'Privacy', href: '#privacy' },
  { name: 'FAQ', href: '#faq' },
  { name: 'Docs', href: 'https://docs.muhaven.app' },
]

// Shared motion config (matches ShadowDAO ease) — visibleOnce = animate once, never re-trigger
const sectionMotion = {
  initial: { opacity: 0, y: 60 },
  visibleOnce: { opacity: 1, y: 0, transition: { duration: 700, ease: [0.22, 1, 0.36, 1] } },
}
function staggerDelay(i: number, base = 0) {
  return {
    initial: { opacity: 0, y: 30 },
    visibleOnce: { opacity: 1, y: 0, transition: { duration: 500, delay: base + i * 120, ease: [0.22, 1, 0.36, 1] } },
  }
}
function slideLeft(delay = 0) {
  return {
    initial: { opacity: 0, x: -30 },
    visibleOnce: { opacity: 1, x: 0, transition: { duration: 600, delay, ease: [0.22, 1, 0.36, 1] } },
  }
}
function slideRight(delay = 0) {
  return {
    initial: { opacity: 0, x: 30 },
    visibleOnce: { opacity: 1, x: 0, transition: { duration: 600, delay, ease: [0.22, 1, 0.36, 1] } },
  }
}
function scaleIn(delay = 0) {
  return {
    initial: { opacity: 0, scale: 0.92 },
    visibleOnce: { opacity: 1, scale: 1, transition: { duration: 700, delay, ease: [0.22, 1, 0.36, 1] } },
  }
}
</script>

<template>
  <div class="min-h-screen">
    <!-- ━━━ LANDING NAV (warm floating pill, static size) ━━━ -->
    <header class="fixed z-50 top-4 left-0 right-0 pointer-events-none">
      <!-- Mobile: a full-width floating pill (mx-4, no max-w cap) so the logo
           and hamburger sit at the edges instead of a tiny content-hugging pill
           floating in the middle. Desktop: the original centered content-fit
           pill. Wave 6 Polish mobile round 2 (operator: "too narrow + font too big"). -->
      <nav
        class="pointer-events-auto mx-4 md:mx-auto flex items-center justify-between glass-panel md:max-w-fit rounded-full h-14 px-5 md:px-6 shadow-[0_0_60px_-10px_rgba(255,186,32,0.12)]"
      >
        <!-- Logo (scroll to top) -->
        <button
          type="button"
          aria-label="Scroll to top"
          class="flex items-center gap-2.5 mr-2 md:mr-6 cursor-pointer group min-w-0"
          @click="scrollToTop"
        >
          <img src="/logo.png" alt="MuHaven" class="w-7 h-7 rounded-lg shrink-0 mix-blend-multiply dark:mix-blend-normal dark:drop-shadow-[0_0_10px_rgba(255,186,32,0.45)] transition-transform duration-300 group-hover:scale-110" />
          <span class="font-sans font-bold text-compute dark:text-signal tracking-tight text-lg md:text-xl transition-all duration-300 group-hover:scale-[1.02]">MuHaven</span>
        </button>

        <!-- Desktop links -->
        <div class="hidden md:flex items-center gap-2">
          <a
            v-for="link in navLinks"
            :key="link.name"
            :href="link.href"
            :target="link.href.startsWith('http') ? '_blank' : undefined"
            :rel="link.href.startsWith('http') ? 'noopener noreferrer' : undefined"
            class="label-text text-[11px] text-slate/70 dark:text-[#d5c4ab]/70 transition-all duration-300 hover:text-compute dark:hover:text-signal hover:bg-haze/20 dark:hover:bg-[#1f2022]/80 px-3 py-1.5 rounded-md"
          >
            {{ link.name }}
          </a>
        </div>

        <!-- Desktop right -->
        <div class="hidden md:flex items-center gap-3 ml-6">
          <MDarkToggle data-testid="nav-dark-toggle" />
          <MButton
            size="sm"
            class="btn-shimmer rounded-full"
            @click="router.push('/portfolio')"
          >
            Launch App
            <ArrowRight :size="14" />
          </MButton>
        </div>

        <!-- Mobile hamburger -->
        <button class="md:hidden p-2 text-compute dark:text-signal" aria-label="Toggle menu" @click="mobileMenuOpen = !mobileMenuOpen">
          <X v-if="mobileMenuOpen" :size="22" />
          <Menu v-else :size="22" />
        </button>
      </nav>
    </header>

    <!-- Mobile full-screen overlay menu -->
    <div
      :class="cn(
        'fixed inset-0 z-40 bg-frost/98 dark:bg-midnight/98 backdrop-blur-xl md:hidden transition-opacity duration-500',
        mobileMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
      )"
    >
      <div class="flex flex-col items-center justify-center h-full gap-8 px-8">
        <a
          v-for="(link, i) in navLinks"
          :key="link.name"
          :ref="(el) => { if (i === 0) mobileMenuFirstLink = el as HTMLAnchorElement }"
          :href="link.href"
          :target="link.href.startsWith('http') ? '_blank' : undefined"
          :rel="link.href.startsWith('http') ? 'noopener noreferrer' : undefined"
          :class="cn(
            'text-4xl font-sans font-bold text-compute dark:text-signal transition-all duration-500',
            mobileMenuOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
          )"
          :style="{ transitionDelay: mobileMenuOpen ? `${i * 75}ms` : '0ms' }"
          @click="mobileMenuOpen = false"
        >
          {{ link.name }}
        </a>
        <div class="pt-4 w-full max-w-xs">
          <MDarkToggle class="mx-auto mb-4" />
          <MButton
            size="lg"
            class="w-full btn-shimmer rounded-full h-14"
            :class="cn(
              'transition-all duration-500',
              mobileMenuOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
            )"
            :style="{ transitionDelay: mobileMenuOpen ? '300ms' : '0ms' }"
            @click="router.push('/portfolio'); mobileMenuOpen = false"
          >
            Launch App
            <ArrowRight :size="16" />
          </MButton>
        </div>
      </div>
    </div>

    <!-- ━━━ HERO SECTION ━━━ -->
    <section class="relative min-h-[90vh] flex items-start pt-16 overflow-hidden">
      <!-- Soft ambient bloom behind hero -->
      <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-[34rem] h-[34rem] bg-signal/5 rounded-full blur-[120px] -z-10 mix-blend-screen pointer-events-none" />
      <div class="absolute bottom-0 left-1/2 -translate-x-1/2 w-[40rem] h-[28rem] bg-gold/5 rounded-full blur-[150px] -z-10 mix-blend-screen pointer-events-none" />

      <div class="max-w-7xl mx-auto w-full px-6 md:px-12 py-20 lg:py-32 grid lg:grid-cols-2 gap-12 items-start">
        <!-- Left: text with staggered entrance -->
        <div>
          <div
            v-motion
            :initial="{ opacity: 0, scale: 0.9, y: 10 }"
            :enter="{ opacity: 1, scale: 1, y: 0, transition: { delay: 200 } }"
            class="mb-6"
          >
            <MBadge variant="teal" :pulse="true">
              Live on Arbitrum Sepolia
            </MBadge>
          </div>

          <div
            v-motion
            :initial="{ opacity: 0, y: 20 }"
            :enter="{ opacity: 1, y: 0, transition: { delay: 300, duration: 600 } }"
            class="mb-8"
          >
            <!--
              Each span is ALWAYS rendered with a `min-h` matching its
              final rendered height — the H1 occupies its full 3-line
              size from t=0, so the subtitle + CTAs don't get pushed
              down as the typewriter writes each line in. Cursor v-ifs
              gate on "this line is currently typing" so three cursors
              don't blink on three empty lines before typing starts.
              Line 3's min-h includes `pb-1` (0.25rem) because Tailwind
              uses border-box — without the calc, the descender padding
              tips the rendered height above the reserve and the box
              grows once the gradient text appears.
            -->
            <h1 ref="heroRef" class="font-sans font-extrabold leading-[1.08] tracking-tight text-midnight dark:text-[#e3e2e5]">
              <span class="block text-5xl md:text-6xl xl:text-7xl min-h-[1.08em]">{{ heroLine1 }}<span v-if="heroLine1 && !line1Done" class="inline-block w-[3px] h-[0.9em] align-[-0.05em] bg-compute dark:bg-signal ml-1" style="animation: typewriter-cursor 0.6s infinite" /></span>
              <span class="block text-5xl md:text-6xl xl:text-7xl min-h-[1.08em]">{{ heroLine2 }}<span v-if="line1Done && !line2Done" class="inline-block w-[3px] h-[0.9em] align-[-0.05em] bg-compute dark:bg-signal ml-1" style="animation: typewriter-cursor 0.6s infinite" /></span>
              <span class="block text-4xl md:text-5xl xl:text-6xl leading-[1.2] mt-2 pb-1 text-transparent bg-clip-text bg-gradient-to-r from-compute to-gold dark:from-signal dark:to-gold min-h-[calc(1.2em_+_0.25rem)]">{{ heroLine3 }}<span v-if="line2Done && !line3Done" class="inline-block w-[3px] h-[0.9em] align-[-0.05em] bg-compute dark:bg-signal ml-1" style="animation: typewriter-cursor 0.6s infinite" /></span>
            </h1>
          </div>

          <p
            v-motion
            :initial="{ opacity: 0, y: 16 }"
            :enter="{ opacity: 1, y: 0, transition: { delay: 500, duration: 600 } }"
            class="font-body text-xl text-slate dark:text-[#d5c4ab] max-w-xl leading-relaxed mb-10"
          >
            Encrypted RWA portfolios on Fhenix CoFHE. Buy, hold, and earn yield without exposing
            a single balance — with an AI copilot that keeps your strategy private.
          </p>

          <div
            v-motion
            :initial="{ opacity: 0, y: 16 }"
            :enter="{ opacity: 1, y: 0, transition: { delay: 700, duration: 600 } }"
            class="flex flex-wrap gap-4"
          >
            <MButton size="lg" class="btn-shimmer rounded-xl" @click="router.push('/portfolio')">
              Launch App
              <ArrowRight :size="16" />
            </MButton>
            <MButton variant="outline" size="lg" class="rounded-xl" @click="scrollToFeatures">
              Learn More
              <ChevronDown :size="16" />
            </MButton>
          </div>
        </div>

        <!-- Right: Data Flow Visualization (desktop) -->
        <div
          class="hidden lg:flex items-center justify-center relative h-[500px]"
          role="img"
          aria-label="Cleartext balances and yields are encrypted via Fhenix CoFHE into euint128 ciphertexts on-chain. Only the investor can decrypt via EIP-712 permit."
        >
          <!-- Soft amber glow -->
          <div class="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,var(--color-signal)_/_10%,transparent_60%)] pointer-events-none" aria-hidden="true" />

          <div class="relative w-[380px] flex flex-col items-center gap-0" aria-hidden="true">
            <!-- Stage 1: Cleartext input -->
            <div
              v-motion
              :initial="{ opacity: 0, y: -30 }"
              :enter="{ opacity: 1, y: 0, transition: { delay: 400, duration: 700 } }"
              class="w-full bg-white/95 dark:bg-[#1f2022]/90 ghost-border rounded-2xl p-5 shadow-lg shadow-negative/10 relative z-10 -rotate-[0.5deg]"
            >
              <div class="flex items-center gap-2.5 mb-3">
                <div class="w-8 h-8 rounded-lg bg-negative/10 flex items-center justify-center">
                  <Eye :size="16" class="text-negative" />
                </div>
                <span class="text-base font-sans font-semibold text-midnight dark:text-[#e3e2e5]">Cleartext Data</span>
              </div>
              <div class="font-mono text-sm text-negative/80 space-y-1">
                <p>balance: <span class="text-negative font-medium">51,247.83 USDC</span></p>
                <p>yield: <span class="text-negative font-medium">$201.34/mo</span></p>
              </div>
            </div>

            <!-- Animated flow line 1 -->
            <div
              v-motion
              :initial="{ opacity: 0, scaleY: 0 }"
              :enter="{ opacity: 1, scaleY: 1, transition: { delay: 900, duration: 500 } }"
              class="w-px h-10 bg-gradient-to-b from-negative/30 via-cool/25 to-signal/30 relative z-0 origin-top"
            >
              <div class="absolute top-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-negative/50" />
              <div class="flow-dot absolute left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-signal" style="animation: flow-down 2s ease-in-out infinite" />
            </div>

            <!-- Stage 2: FHE Encryption zone -->
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.9 }"
              :enter="{ opacity: 1, scale: 1, transition: { delay: 1100, duration: 700 } }"
              class="w-full bg-midnight dark:bg-midnight-deep ring-1 ring-gold/30 rounded-2xl p-5 shadow-xl shadow-gold/10 relative z-10 ambient-glow"
            >
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-lg bg-gold/15 flex items-center justify-center">
                    <Lock :size="16" class="text-gold" />
                  </div>
                  <span class="text-base font-sans font-semibold text-white">Fhenix CoFHE Encryption</span>
                </div>
                <MBadge variant="fhe">CoFHE</MBadge>
              </div>
              <div class="font-mono text-sm space-y-1.5">
                <p class="text-signal">FHE.asEuint128(amount)</p>
                <p class="text-[#d5c4ab]">FHE.allow(handle, owner)</p>
                <p class="text-gold">FHE.select(cond, val, zero)</p>
              </div>
              <!-- Pulsing amber ring -->
              <div class="absolute -inset-px rounded-2xl ring-1 ring-gold/20" style="animation: pulse-ring 3s ease-in-out infinite" />
            </div>

            <!-- Animated flow line 2 -->
            <div
              v-motion
              :initial="{ opacity: 0, scaleY: 0 }"
              :enter="{ opacity: 1, scaleY: 1, transition: { delay: 1500, duration: 500 } }"
              class="w-px h-10 bg-gradient-to-b from-gold/40 via-signal/30 to-signal/20 relative z-0 origin-top"
            >
              <div class="flow-dot absolute left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-signal" style="animation: flow-down 2s ease-in-out infinite; animation-delay: -1s" />
              <div class="absolute bottom-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-signal/50" />
            </div>

            <!-- Stage 3: Encrypted output -->
            <div
              v-motion
              :initial="{ opacity: 0, y: 30 }"
              :enter="{ opacity: 1, y: 0, transition: { delay: 1700, duration: 700 } }"
              class="w-full bg-white/95 dark:bg-[#1f2022]/90 ghost-border rounded-2xl p-5 shadow-lg shadow-signal/10 relative z-10 rotate-[0.5deg]"
            >
              <div class="flex items-center gap-2.5 mb-3">
                <div class="w-8 h-8 rounded-lg bg-compute/10 dark:bg-signal/10 flex items-center justify-center">
                  <EyeOff :size="16" class="text-compute dark:text-signal" />
                </div>
                <span class="text-base font-sans font-semibold text-midnight dark:text-[#e3e2e5]">Encrypted On-Chain</span>
              </div>
              <div class="font-mono text-sm text-compute/80 dark:text-signal/70 space-y-1">
                <p>balance: <span class="text-compute dark:text-signal font-medium">euint128(******)</span></p>
                <p>yield: <span class="text-compute dark:text-signal font-medium">euint128(******)</span></p>
              </div>
              <div class="flex items-center gap-2 mt-3">
                <Shield :size="12" class="text-compute dark:text-signal" />
                <span class="font-body text-sm text-cool">Only you can decrypt via EIP-712 permit</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Mobile hero cards (decorative — desktop viz already conveys the story to assistive tech) -->
        <div class="lg:hidden flex flex-col items-center gap-4" aria-hidden="true">
          <div class="w-[85%] bg-white dark:bg-midnight-mid ghost-border rounded-2xl p-5 shadow-2xl relative">
            <div class="absolute -inset-8 bg-[radial-gradient(circle,var(--color-signal)_/_10%,transparent_60%)] pointer-events-none" />
            <p class="label-text text-xs text-cool mb-1">Total Portfolio</p>
            <p class="text-2xl font-sans font-bold text-midnight dark:text-[#e3e2e5] tabular-nums">$51,247.83</p>
            <div class="flex items-center gap-2 mt-2">
              <MBadge variant="positive">+2.3%</MBadge>
            </div>
            <div class="flex gap-1 mt-3">
              <div class="h-1.5 rounded-full bg-compute dark:bg-signal" style="width: 70%" />
              <div class="h-1.5 rounded-full bg-gold" style="width: 20%" />
              <div class="h-1.5 rounded-full bg-cipher" style="width: 10%" />
            </div>
          </div>
          <div class="w-[75%] -mt-3 bg-midnight dark:bg-midnight-deep ring-1 ring-gold/25 rounded-2xl p-4 shadow-lg shadow-gold/10 z-10">
            <div class="flex items-center gap-2 mb-2">
              <Lock :size="12" class="text-gold" />
              <span class="label-text text-[10px] text-gold">FHE Encrypted</span>
            </div>
            <div class="font-mono text-sm text-signal/70 space-y-1">
              <p>balance: <span class="text-signal">euint128(******)</span></p>
              <p>yields:&nbsp; <span class="text-signal">euint128(******)</span></p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ━━━ POWERED BY BAR (thin panel, hover-to-full-contrast) ━━━ -->
    <div class="w-full bg-mist/70 dark:bg-[#0d0e10] border-y border-haze/60 dark:border-[#514532]/25 py-6 overflow-hidden">
      <div class="max-w-7xl mx-auto px-6 flex flex-wrap justify-center lg:justify-between items-center gap-8 lg:gap-12 opacity-80 hover:opacity-100 transition-opacity duration-500">
        <span
          v-for="(tech, i) in ['FHENIX', 'ARBITRUM', 'CoFHE', 'ERC-3643', 'CHAINLINK', 'ZeroDev']"
          :key="tech"
          v-motion
          :initial="{ opacity: 0, y: 10 }"
          :visible-once="{ opacity: 1, y: 0, transition: { delay: i * 100 } }"
          class="label-text text-sm font-bold text-slate/85 dark:text-[#d5c4ab]/75 hover:text-compute dark:hover:text-signal transition-colors duration-300"
        >
          {{ tech }}
        </span>
      </div>
    </div>

    <!-- ━━━ STATS STRIP ━━━ -->
    <section class="py-16 lg:py-20 relative">
      <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--color-signal)_/_5%,transparent_70%)] pointer-events-none" />
      <div class="relative max-w-5xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
        <div
          v-for="(stat, i) in LANDING_STATS"
          :key="i"
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :visible-once="{ opacity: 1, y: 0, transition: { delay: i * 100, duration: 500 } }"
          class="bg-white/70 dark:bg-midnight-mid/60 ghost-border rounded-2xl px-6 py-6 border-t-[3px] border-compute dark:border-signal"
        >
          <component :is="statIcons[i]" :size="20" class="text-compute dark:text-signal mx-auto mb-3" />
          <p :ref="(el) => { if (el) statRefs[i].target.value = el as HTMLElement }" class="text-4xl md:text-5xl font-sans font-extrabold text-midnight dark:text-[#e3e2e5] tabular-nums">
            {{ stat.prefix }}{{ statRefs[i].displayValue.value }}<span v-if="stat.suffix" class="font-normal text-cool">{{ stat.suffix }}</span>
          </p>
          <p class="label-text text-xs text-cool mt-3">{{ stat.label }}</p>
        </div>
      </div>
    </section>

    <div class="h-px bg-gradient-to-r from-transparent via-haze/50 dark:via-[#514532]/30 to-transparent" />

    <!-- ━━━ BEFORE vs AFTER ━━━ -->
    <section id="privacy" class="py-20 md:py-28 lg:py-36 scroll-mt-24">
      <div class="max-w-6xl mx-auto px-6">
        <div v-motion v-bind="sectionMotion">
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold text-center tracking-tight leading-[1.1] text-midnight dark:text-[#e3e2e5] mb-4">
            The Privacy Problem
          </h2>
          <p class="font-body text-center text-xl text-slate dark:text-[#d5c4ab] max-w-2xl mx-auto mt-2 mb-10 lg:mb-14">
            Traditional RWA platforms expose balances and yields. MuHaven encrypts both.
          </p>
        </div>

        <div class="grid md:grid-cols-2 gap-6 relative">
          <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 md:hidden">
            <div class="bg-midnight text-gold rounded-full w-10 h-10 flex items-center justify-center text-sm font-bold shadow-lg label-text">VS</div>
          </div>

          <!-- Before -->
          <div v-motion v-bind="slideLeft(200)" class="bg-white dark:bg-midnight-mid border-2 border-negative/15 rounded-2xl p-8 shadow-lg shadow-negative/5">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-10 h-10 rounded-xl bg-negative/10 flex items-center justify-center">
                <Eye :size="20" class="text-negative" />
              </div>
              <div>
                <h3 class="font-sans font-bold text-xl text-midnight dark:text-[#e3e2e5]">Transparent RWA Platforms</h3>
                <p class="text-sm text-cool">Ondo, Securitize, Centrifuge</p>
              </div>
            </div>
            <ul class="space-y-3">
              <li
                v-for="(item, i) in [
                  'Balances visible to anyone with a block explorer',
                  'Yield distributions reveal position sizes',
                  'AI agent strategies are front-runnable',
                  'KYC + on-chain wealth = physical security risk',
                ]"
                :key="item"
                v-motion
                :initial="{ opacity: 0, x: -20 }"
                :visible-once="{ opacity: 1, x: 0, transition: { delay: 300 + i * 100, duration: 400 } }"
                class="flex items-start gap-2.5 text-base font-body text-slate dark:text-[#d5c4ab]"
              >
                <span class="text-negative mt-0.5">&#10007;</span>
                <span>{{ item }}</span>
              </li>
            </ul>
            <div class="mt-5 bg-frost dark:bg-[#0d0e10] rounded-lg p-4 font-mono text-sm text-negative/80 shadow-inner">
              balance[0x7a3f] = <span class="text-negative font-bold">51,247.83 USDC</span> // public
            </div>
          </div>

          <!-- After -->
          <div v-motion v-bind="slideRight(200)" class="bg-white dark:bg-midnight-mid border-2 border-compute/15 dark:border-signal/20 rounded-2xl p-8 shadow-lg shadow-compute/5 dark:shadow-signal/10">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-10 h-10 rounded-xl bg-compute/10 dark:bg-signal/10 flex items-center justify-center">
                <EyeOff :size="20" class="text-compute dark:text-signal" />
              </div>
              <div>
                <h3 class="font-sans font-bold text-xl text-midnight dark:text-[#e3e2e5]">MuHaven + Fhenix CoFHE</h3>
                <p class="text-sm text-cool">Encrypted by default</p>
              </div>
            </div>
            <ul class="space-y-3">
              <li
                v-for="(item, i) in [
                  'Balances encrypted as euint128 on-chain',
                  'Pull-based yield — encrypted shares, mhUSDC payout',
                  'Atomic single-tx purchase — no plaintext intermediate state',
                  'Only the investor can decrypt via EIP-712 permit',
                ]"
                :key="item"
                v-motion
                :initial="{ opacity: 0, x: 20 }"
                :visible-once="{ opacity: 1, x: 0, transition: { delay: 300 + i * 100, duration: 400 } }"
                class="flex items-start gap-2.5 text-base font-body text-slate dark:text-[#d5c4ab]"
              >
                <span class="text-compute dark:text-signal mt-0.5">&#10003;</span>
                <span>{{ item }}</span>
              </li>
            </ul>
            <div class="mt-5 bg-frost dark:bg-[#0d0e10] rounded-lg p-4 font-mono text-sm text-compute/80 dark:text-signal/80 shadow-inner">
              balance[0x7a3f] = <span class="text-compute dark:text-signal font-bold">euint128(******)</span> // encrypted
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="h-px bg-gradient-to-r from-transparent via-haze/50 dark:via-[#514532]/30 to-transparent" />

    <!-- ━━━ FEATURES GRID ━━━ -->
    <section id="features" ref="featuresSection" class="py-20 md:py-28 lg:py-36 bg-white/60 dark:bg-midnight-mid/30 backdrop-blur-sm scroll-mt-24">
      <div class="max-w-6xl mx-auto px-6">
        <div v-motion v-bind="sectionMotion">
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold text-center tracking-tight leading-[1.1] text-midnight dark:text-[#e3e2e5] mb-4">
            Three Layers of Privacy
          </h2>
          <p class="font-body text-center text-xl text-slate dark:text-[#d5c4ab] max-w-2xl mx-auto mt-2 mb-10 lg:mb-14">
            Balance privacy, yield privacy, and AI privacy — solved together because solving them separately would be architecturally incomplete.
          </p>
        </div>

        <div class="grid md:grid-cols-3 gap-8">
          <div
            v-for="(feat, i) in LANDING_FEATURES"
            :key="i"
            v-motion
            v-bind="staggerDelay(i)"
            class="bg-white dark:bg-midnight-mid ghost-border rounded-xl p-7 shadow-lg shadow-compute/5 dark:shadow-signal/5 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-xl hover:shadow-signal/15 hover:border-compute/30 dark:hover:border-signal/30 cursor-pointer group"
          >
            <div class="w-12 h-12 rounded-xl bg-compute/10 dark:bg-signal/10 flex items-center justify-center mb-5 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-110">
              <component :is="featureIcons[feat.icon]" :size="24" class="text-compute dark:text-signal" />
            </div>
            <h3 class="text-xl font-sans font-bold text-midnight dark:text-[#e3e2e5] mb-3">
              {{ feat.title }}
            </h3>
            <p class="font-body text-base text-slate dark:text-[#d5c4ab] leading-relaxed mb-5">
              {{ feat.description }}
            </p>
            <div class="bg-frost dark:bg-[#0d0e10] rounded-lg px-4 py-3 font-mono text-sm text-compute dark:text-signal ghost-border">
              {{ feat.code }}
            </div>
          </div>
        </div>

        <!-- Agentic layer — HavenBot + MCP live; OpenClaw + Checkout in development -->
        <div
          v-motion
          :initial="{ opacity: 0, y: 16 }"
          :visible-once="{ opacity: 1, y: 0, transition: { delay: 200, duration: 500 } }"
          class="mt-12 flex flex-col sm:flex-row items-center justify-center gap-3 text-center"
        >
          <MBadge variant="fhe">{{ LANDING_AI_PREVIEW.badge }}</MBadge>
          <p class="font-body text-sm text-slate dark:text-[#d5c4ab] max-w-3xl">
            {{ LANDING_AI_PREVIEW.text }}
          </p>
        </div>

        <!-- Live agentic surfaces: in-dashboard copilot + bring-your-own AI assistant -->
        <div
          v-motion
          :initial="{ opacity: 0, y: 24 }"
          :visible-once="{ opacity: 1, y: 0, transition: { delay: 250, duration: 600 } }"
          class="mt-8 grid md:grid-cols-2 gap-6"
        >
          <div class="bg-white dark:bg-midnight-mid ghost-border rounded-xl p-6 shadow-lg shadow-compute/5 dark:shadow-signal/5">
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 rounded-xl bg-compute/10 dark:bg-signal/10 flex items-center justify-center">
                <Bot :size="20" class="text-compute dark:text-signal" />
              </div>
              <h3 class="font-sans font-bold text-lg text-midnight dark:text-[#e3e2e5]">HavenBot copilot</h3>
            </div>
            <p class="font-body text-base text-slate dark:text-[#d5c4ab] leading-relaxed">
              Ask in plain language, confirm with a tap. HavenBot proposes buys, yield claims, and
              rebalances — every action runs on your encrypted balances inside the dashboard.
            </p>
          </div>

          <a
            href="https://docs.muhaven.app/mcp/overview"
            target="_blank"
            rel="noopener noreferrer"
            class="block bg-white dark:bg-midnight-mid ghost-border rounded-xl p-6 shadow-lg shadow-compute/5 dark:shadow-signal/5 transition-all duration-300 hover:-translate-y-1 hover:border-compute/30 dark:hover:border-signal/30 group"
          >
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 rounded-xl bg-gold/10 flex items-center justify-center">
                <FileCode :size="20" class="text-gold" />
              </div>
              <h3 class="font-sans font-bold text-lg text-midnight dark:text-[#e3e2e5]">Drive it from your AI assistant</h3>
            </div>
            <p class="font-body text-base text-slate dark:text-[#d5c4ab] leading-relaxed">
              Install <code class="font-mono text-sm text-compute dark:text-signal">@muhaven/mcp</code>
              and manage your confidential portfolio from Claude Desktop, Cursor, or Claude Code —
              25 tools, tiered autonomy, optional read-only mode.
            </p>
            <span class="inline-flex items-center gap-1.5 mt-4 label-text text-xs text-compute dark:text-signal group-hover:gap-2.5 transition-all">
              Read the MCP guide <ArrowRight :size="13" />
            </span>
          </a>
        </div>
      </div>
    </section>

    <!-- ━━━ CODE SNIPPET SECTION ━━━ -->
    <section id="how-it-works" class="py-20 md:py-28 lg:py-36 bg-midnight-deep relative scroll-mt-24">
      <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--color-gold)_/_4%,transparent_65%)] pointer-events-none" />
      <div class="relative max-w-6xl mx-auto px-6 grid lg:grid-cols-2 gap-12 items-center">
        <div v-motion v-bind="sectionMotion">
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold tracking-tight leading-[1.1] text-white mb-4">
            FHE Operations <span class="text-transparent bg-clip-text bg-gradient-to-r from-signal to-gold">On-Chain</span>
          </h2>
          <p class="font-body text-xl text-[#d5c4ab] leading-relaxed mb-8">
            Standard Solidity. Encrypted types. Every transfer, yield calculation, and balance check
            runs on ciphertext — same gas cost whether the operation succeeds or fails.
          </p>
          <div class="flex flex-wrap gap-3">
            <MBadge variant="fhe">euint128</MBadge>
            <MBadge variant="fhe">ebool</MBadge>
            <MBadge variant="fhe">eaddress</MBadge>
            <MBadge variant="fhe">FHE.select</MBadge>
          </div>
        </div>

        <div v-motion v-bind="scaleIn(150)" class="bg-[#0d0e10] rounded-2xl ring-1 ring-[#514532]/30 overflow-hidden shadow-elevated">
          <div class="flex items-center gap-2 px-5 py-3.5 border-b border-[#514532]/25">
            <div class="w-3 h-3 rounded-full bg-negative/60" />
            <div class="w-3 h-3 rounded-full bg-gold/70" />
            <div class="w-3 h-3 rounded-full bg-signal/60" />
            <span class="ml-3 font-mono text-sm text-[#d5c4ab]/50">MuHavenToken.sol</span>
          </div>
          <div class="p-5 overflow-x-auto">
            <pre class="text-base leading-relaxed"><code><span
              v-for="(line, i) in LANDING_CODE_LINES"
              :key="i"
              v-motion
              :initial="{ opacity: 0, x: -20 }"
              :visible-once="{ opacity: 1, x: 0, transition: { delay: 100 + i * 80, duration: 400 } }"
              :class="[
                'block',
                line.color === 'compute' ? 'text-signal'
                  : line.color === 'signal' ? 'text-[#ffe9c4]'
                  : line.color === 'gold' ? 'text-gold'
                  : line.color === 'cipher' ? 'text-cipher'
                  : line.color === 'cool' ? 'text-[#9e8f78]/70'
                  : 'text-white/85',
              ]"
            >{{ line.text }}</span></code></pre>
          </div>
        </div>
      </div>
    </section>

    <!-- ━━━ TWO-SIDED PLATFORM ━━━ -->
    <section class="py-20 md:py-28 lg:py-36">
      <div class="max-w-6xl mx-auto px-6">
        <div v-motion v-bind="sectionMotion">
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold text-center tracking-tight leading-[1.1] text-midnight dark:text-[#e3e2e5] mb-4">
            Two-Sided Platform
          </h2>
          <p class="font-body text-center text-xl text-slate dark:text-[#d5c4ab] max-w-2xl mx-auto mt-2 mb-10 lg:mb-14">
            Issuers create RWA tokens and deposit yield. Investors buy tokens and earn yield privately. Both sides share the same encrypted contracts.
          </p>
        </div>

        <div class="grid md:grid-cols-2 gap-8">
          <!-- Investor flow -->
          <div v-motion v-bind="slideLeft(200)" class="bg-white dark:bg-midnight-mid ghost-border rounded-xl p-7 shadow-lg shadow-compute/5 dark:shadow-signal/5 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-xl hover:shadow-signal/15 hover:border-compute/30 dark:hover:border-signal/30 cursor-pointer group">
            <div class="flex items-center gap-3 mb-6">
              <div class="w-10 h-10 rounded-xl bg-compute/10 dark:bg-signal/10 flex items-center justify-center transition-transform duration-300 group-hover:rotate-[-8deg] group-hover:scale-110">
                <Shield :size="20" class="text-compute dark:text-signal" />
              </div>
              <h3 class="font-sans font-bold text-xl text-midnight dark:text-[#e3e2e5]">Investors</h3>
            </div>
            <div class="space-y-4">
              <div v-for="(step, i) in [
                'Wrap USDC into mhUSDC (confidential settlement)',
                'Buy fhERC-20 RWA tokens — atomic single-tx, encrypted balances',
                'Pull yield per epoch — only you can decrypt',
                'AI copilot for advice and policy-bound execution',
              ]" :key="i" class="flex items-start gap-3">
                <div class="w-7 h-7 rounded-full bg-compute/10 dark:bg-signal/10 text-compute dark:text-signal flex items-center justify-center text-sm font-bold shrink-0 mt-0.5">
                  {{ i + 1 }}
                </div>
                <p class="font-body text-base text-slate dark:text-[#d5c4ab]">{{ step }}</p>
              </div>
            </div>
          </div>

          <!-- Issuer flow -->
          <div v-motion v-bind="slideRight(200)" class="bg-white dark:bg-midnight-mid ghost-border rounded-xl p-7 shadow-lg shadow-gold/5 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-xl hover:shadow-gold/15 hover:border-gold/30 dark:hover:border-gold/40 cursor-pointer group">
            <div class="flex items-center gap-3 mb-6">
              <div class="w-10 h-10 rounded-xl bg-gold/10 flex items-center justify-center transition-transform duration-300 group-hover:rotate-[-8deg] group-hover:scale-110">
                <TrendingUp :size="20" class="text-gold" />
              </div>
              <h3 class="font-sans font-bold text-xl text-midnight dark:text-[#e3e2e5]">Issuers</h3>
            </div>
            <div class="space-y-4">
              <div v-for="(step, i) in [
                'Onboard fhERC-20 RWA token via the self-serve wizard',
                'Bind compliance modules (jurisdiction, holders, lockup)',
                'Open epoch → snapshot holders → fund mhUSDC',
                'Investors pull their own share — issuer sees aggregates',
              ]" :key="i" class="flex items-start gap-3">
                <div class="w-7 h-7 rounded-full bg-gold/10 text-gold flex items-center justify-center text-sm font-bold shrink-0 mt-0.5">
                  {{ i + 1 }}
                </div>
                <p class="font-body text-base text-slate dark:text-[#d5c4ab]">{{ step }}</p>
              </div>
            </div>
            <div class="mt-7 pt-5 border-t border-haze/40 dark:border-[#514532]/25">
              <MButton variant="outline" size="md" class="rounded-xl w-full sm:w-auto" @click="goToIssuerOnboarding">
                Onboard a Token
                <ArrowRight :size="14" />
              </MButton>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="h-px bg-gradient-to-r from-transparent via-haze/50 dark:via-[#514532]/30 to-transparent" />

    <!-- ━━━ FAQ ━━━ -->
    <section id="faq" class="py-20 md:py-28 lg:py-36 bg-white/60 dark:bg-midnight-mid/30 backdrop-blur-sm scroll-mt-24">
      <div class="max-w-3xl mx-auto px-6">
        <div v-motion v-bind="sectionMotion">
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold text-center tracking-tight leading-[1.1] text-midnight dark:text-[#e3e2e5] mb-4">
            Frequently Asked Questions
          </h2>
          <p class="font-body text-center text-xl text-slate dark:text-[#d5c4ab] mt-2 mb-10 lg:mb-14">
            Common questions about privacy, FHE, and how MuHaven works.
          </p>
        </div>
        <MAccordion :items="LANDING_FAQ" />
      </div>
    </section>

    <div class="h-px bg-gradient-to-r from-transparent via-haze/50 dark:via-[#514532]/30 to-transparent" />

    <!-- ━━━ CTA ━━━ -->
    <section class="py-20 md:py-28 lg:py-36">
      <div class="max-w-4xl mx-auto px-6">
        <div
          v-motion v-bind="scaleIn()"
          class="bg-midnight dark:bg-midnight-deep rounded-3xl p-10 md:p-16 text-center ring-1 ring-gold/15 dark:ring-gold/20 relative overflow-hidden shadow-elevated"
        >
          <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--color-signal)_/_15%,var(--color-midnight-deep)_70%)]" />
          <div class="absolute w-40 h-40 rounded-full bg-gold/8 blur-3xl top-8 left-1/4" style="animation: drift 25s infinite alternate ease-in-out" />
          <div class="absolute w-28 h-28 rounded-full bg-signal/6 blur-3xl bottom-12 right-1/4" style="animation: drift 20s infinite alternate ease-in-out; animation-delay: -8s" />
          <div class="absolute w-24 h-24 rounded-full bg-cipher/6 blur-3xl top-1/2 right-1/3" style="animation: drift 30s infinite alternate ease-in-out; animation-delay: -15s" />

          <div class="relative">
            <h2 class="text-3xl md:text-4xl font-sans font-extrabold text-white mb-4">
              Start Managing Your Portfolio <span class="text-transparent bg-clip-text bg-gradient-to-r from-signal to-gold">Privately</span>
            </h2>
            <p class="font-body text-xl text-[#d5c4ab] max-w-xl mx-auto mb-8">
              Encrypted balances, private yields, atomic encrypted purchase. An AI copilot manages your portfolio — and still can't see your strategy.
            </p>
            <div class="flex flex-wrap items-center justify-center gap-4 mb-6">
              <MButton size="lg" class="btn-shimmer rounded-xl" @click="router.push('/portfolio')">
                Launch App
                <ArrowRight :size="16" />
              </MButton>
              <MButton variant="outline" size="lg" class="rounded-xl border-[#d5c4ab]/20 text-white hover:border-signal hover:text-signal dark:border-[#d5c4ab]/20 dark:text-white dark:hover:border-signal dark:hover:text-signal">
                <Github :size="16" />
                GitHub
              </MButton>
              <MButton
                variant="outline"
                size="lg"
                class="rounded-xl border-[#d5c4ab]/20 text-white hover:border-signal hover:text-signal dark:border-[#d5c4ab]/20 dark:text-white dark:hover:border-signal dark:hover:text-signal"
                @click="openArbiscan"
              >
                <ExternalLink :size="16" />
                Arbiscan
              </MButton>
            </div>
            <p class="label-text text-xs text-[#d5c4ab]/70">Testnet open access &middot; No real funds at risk</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Final one-liner CTA -->
    <div class="text-center py-8">
      <p class="font-body text-base text-slate dark:text-[#d5c4ab]">
        Ready to go private?
        <button class="text-compute dark:text-signal hover:text-compute-hover dark:hover:text-signal-hover font-semibold ml-1 cursor-pointer" @click="router.push('/portfolio')">
          Launch App &rarr;
        </button>
      </p>
    </div>

    <!-- ━━━ FOOTER ━━━ -->
    <!-- pb-32 on mobile clears the fixed bottom sticky "Launch App" CTA (it's
         shown all the way to the bottom: scrollY > 0.9·innerHeight), which was
         covering the footer. md:pb-10 restores the desktop footer (no sticky CTA
         there — it's md:hidden). Wave 6 Polish mobile round 2. -->
    <footer class="border-t border-haze/50 dark:border-[#514532]/20 pt-10 pb-32 md:py-10">
      <div class="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
        <div class="flex items-center gap-2.5">
          <img src="/logo.png" alt="MuHaven" class="w-6 h-6 rounded-md mix-blend-multiply dark:mix-blend-normal dark:drop-shadow-[0_0_8px_rgba(255,186,32,0.4)]" />
          <div class="flex flex-col">
            <span class="text-base font-sans font-semibold text-compute dark:text-signal">MuHaven</span>
            <span class="font-body text-xs text-cool">© 2026 MuHaven. Privacy as Architecture.</span>
          </div>
        </div>
        <div class="flex items-center gap-6">
          <a class="label-text text-xs text-cool hover:text-compute dark:hover:text-signal transition-colors" href="https://docs.muhaven.app" target="_blank" rel="noopener noreferrer">Docs</a>
          <a class="label-text text-xs text-cool hover:text-compute dark:hover:text-signal transition-colors" href="#">Privacy</a>
          <a class="label-text text-xs text-cool hover:text-compute dark:hover:text-signal transition-colors" href="#">Terms</a>
          <a class="label-text text-xs text-cool hover:text-compute dark:hover:text-signal transition-colors" href="#">Twitter</a>
          <a class="label-text text-xs text-cool hover:text-compute dark:hover:text-signal transition-colors" href="#">GitHub</a>
          <span
            data-testid="footer-app-version"
            class="font-mono text-[11px] text-cool/70 dark:text-cool/60 tabular-nums"
            :title="`MuHaven ${versionLabel}`"
          >{{ versionLabel }}</span>
        </div>
      </div>
    </footer>

    <!-- Mobile sticky CTA -->
    <Transition name="sticky-cta">
      <div
        v-if="showStickyCTA"
        class="fixed bottom-0 left-0 right-0 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] bg-frost/90 dark:bg-midnight/90 backdrop-blur-xl border-t border-haze/40 dark:border-[#514532]/30 z-40 md:hidden"
      >
        <MButton size="lg" class="w-full btn-shimmer rounded-xl" @click="router.push('/portfolio')">
          Launch App
          <ArrowRight :size="16" />
        </MButton>
      </div>
    </Transition>
  </div>
</template>

<style>
/* Honor prefers-reduced-motion globally on this surface — kills the
 * cursor blink, flow-down pulses, ambient drift, and any v-motion /
 * Tailwind transition durations. The typewriter still ticks chars
 * in via setInterval (JS, not CSS), but with the subtitle + CTA
 * gating removed it's purely cosmetic — the page is usable from t=0.
 * Unscoped because the rule must reach v-motion children + global
 * keyframes (`flow-down`, `pulse-ring`, `drift`, `typewriter-cursor`).
 */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
</style>
