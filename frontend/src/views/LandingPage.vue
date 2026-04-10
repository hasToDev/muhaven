<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useGlassNav } from '@/composables/useGlassNav'
import { useTypewriter } from '@/composables/useTypewriter'
import { useCountUp } from '@/composables/useCountUp'
import { cn } from '@/lib/utils'

import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MAccordion from '@/components/ui/MAccordion.vue'
import MDarkToggle from '@/components/ui/MDarkToggle.vue'

import {
  Shield, TrendingUp, Sparkles, Lock,
  ArrowRight, Github, ExternalLink, Eye, EyeOff,
  ChevronDown, FileCode, ShieldCheck, Bot, Menu, X,
} from 'lucide-vue-next'

import {
  LANDING_STATS, LANDING_FEATURES, LANDING_FAQ, LANDING_CODE_LINES,
} from '@/data/constants'

const router = useRouter()
const store = useAppStore()
const { isScrolled } = useGlassNav()

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
const featureIcons = { Shield, TrendingUp, Sparkles } as Record<string, any>

const heroLoaded = ref(false)
onMounted(() => { requestAnimationFrame(() => { heroLoaded.value = true }) })

const mobileMenuOpen = ref(false)
const showStickyCTA = ref(false)
function onScroll() { showStickyCTA.value = window.scrollY > window.innerHeight * 0.9 }
onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }))
onUnmounted(() => window.removeEventListener('scroll', onScroll))

const featuresSection = ref<HTMLElement | null>(null)
function scrollToFeatures() { featuresSection.value?.scrollIntoView({ behavior: 'smooth' }) }

const navLinks = [
  { name: 'Features', href: '#features' },
  { name: 'How It Works', href: '#how-it-works' },
  { name: 'Privacy', href: '#privacy' },
  { name: 'FAQ', href: '#faq' },
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
    <!-- ━━━ LANDING NAV (Walnut-style floating pill) ━━━ -->
    <header
      :class="cn(
        'fixed z-50 transition-all duration-500',
        isScrolled
          ? 'top-4 left-4 right-4'
          : 'top-0 left-0 right-0',
      )"
    >
      <nav
        :class="cn(
          'mx-auto flex items-center justify-between px-6 transition-all duration-500',
          isScrolled
            ? 'glass-panel max-w-5xl rounded-2xl h-14'
            : 'max-w-7xl bg-transparent h-20',
        )"
      >
        <!-- Logo -->
        <div class="flex items-center gap-2.5">
          <img src="/logo.jpg" alt="MuHaven" class="w-8 h-8 rounded-lg" style="mix-blend-mode: multiply" />
          <span :class="cn('font-sans font-bold text-midnight dark:text-white tracking-tight transition-all duration-500', isScrolled ? 'text-base' : 'text-xl')">MuHaven</span>
        </div>

        <!-- Desktop links -->
        <div class="hidden md:flex items-center gap-10">
          <a
            v-for="link in navLinks"
            :key="link.name"
            :href="link.href"
            class="nav-link-underline text-sm text-slate/75 dark:text-cool/75 transition-colors duration-300 hover:text-midnight dark:hover:text-white"
          >
            {{ link.name }}
          </a>
        </div>

        <!-- Desktop right -->
        <div class="hidden md:flex items-center gap-3">
          <MDarkToggle />
          <MButton
            :size="isScrolled ? 'sm' : 'sm'"
            class="btn-shimmer rounded-full"
            @click="router.push('/portfolio')"
          >
            Launch App
            <ArrowRight :size="14" />
          </MButton>
        </div>

        <!-- Mobile hamburger -->
        <button class="md:hidden p-2 text-midnight dark:text-white" aria-label="Toggle menu" @click="mobileMenuOpen = !mobileMenuOpen">
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
          :href="link.href"
          :class="cn(
            'text-4xl font-sans font-bold text-midnight dark:text-white transition-all duration-500',
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
            class="mb-6"
          >
            <div ref="heroRef">
              <h1 class="font-sans font-extrabold leading-[1.08] tracking-tight text-midnight dark:text-white">
                <span v-if="heroLine1" class="block text-5xl md:text-6xl xl:text-7xl">{{ heroLine1 }}<span v-if="!line1Done" class="inline-block w-[3px] h-[1em] bg-compute ml-1" style="animation: typewriter-cursor 0.6s infinite" /></span>
                <span v-if="line1Done" class="block text-5xl md:text-6xl xl:text-7xl">{{ heroLine2 }}<span v-if="!line2Done" class="inline-block w-[3px] h-[1em] bg-compute ml-1" style="animation: typewriter-cursor 0.6s infinite" /></span>
              </h1>
              <h2 v-if="line2Done" class="text-4xl md:text-5xl xl:text-6xl font-sans font-extrabold leading-[1.08] tracking-tight text-compute dark:text-signal mt-2">
                {{ heroLine3 }}<span v-if="!line3Done" class="inline-block w-[3px] h-[1em] bg-compute ml-1" style="animation: typewriter-cursor 0.6s infinite" />
              </h2>
            </div>
          </div>

          <p
            :class="cn(
              'text-xl text-slate dark:text-cool max-w-xl leading-relaxed mb-10 transition-all duration-700',
              line3Done ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
            )"
          >
            Encrypted RWA management powered by Fhenix FHE. Deposit, earn yield, and let AI optimize
            your portfolio — all without exposing a single balance.
          </p>

          <div
            :class="cn(
              'flex flex-wrap gap-4 transition-all duration-700 delay-200',
              line3Done ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
            )"
          >
            <MButton size="lg" class="btn-shimmer" @click="router.push('/portfolio')">
              Launch App
              <ArrowRight :size="16" />
            </MButton>
            <MButton variant="outline" size="lg" @click="scrollToFeatures">
              Learn More
              <ChevronDown :size="16" />
            </MButton>
          </div>
        </div>

        <!-- Right: Data Flow Visualization (desktop) -->
        <div class="hidden lg:flex items-center justify-center relative h-[500px]">
          <!-- Soft glow -->
          <div class="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,var(--color-compute)_/_8%,transparent_60%)] pointer-events-none" />

          <div class="relative w-[380px] flex flex-col items-center gap-0">
            <!-- Stage 1: Cleartext input -->
            <div
              v-motion
              :initial="{ opacity: 0, y: -30 }"
              :enter="{ opacity: 1, y: 0, transition: { delay: 400, duration: 700 } }"
              class="w-full bg-white/90 dark:bg-midnight-mid/90 ring-1 ring-negative/15 rounded-2xl p-5 shadow-lg relative z-10"
            >
              <div class="flex items-center gap-2.5 mb-3">
                <div class="w-8 h-8 rounded-lg bg-negative/10 flex items-center justify-center">
                  <Eye :size="16" class="text-negative" />
                </div>
                <span class="text-base font-semibold text-midnight dark:text-white">Cleartext Data</span>
              </div>
              <div class="font-mono text-sm text-negative/70 space-y-1">
                <p>balance: <span class="text-negative font-medium">51,247.83 USDC</span></p>
                <p>yield: <span class="text-negative font-medium">$201.34/mo</span></p>
              </div>
            </div>

            <!-- Animated flow line 1 -->
            <div
              v-motion
              :initial="{ opacity: 0, scaleY: 0 }"
              :enter="{ opacity: 1, scaleY: 1, transition: { delay: 900, duration: 500 } }"
              class="w-px h-10 bg-gradient-to-b from-negative/30 via-cool/20 to-compute/30 relative z-0 origin-top"
            >
              <div class="absolute top-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-negative/50" />
              <div class="flow-dot absolute left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-compute" style="animation: flow-down 2s ease-in-out infinite" />
            </div>

            <!-- Stage 2: FHE Encryption zone -->
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.9 }"
              :enter="{ opacity: 1, scale: 1, transition: { delay: 1100, duration: 700 } }"
              class="w-full bg-midnight dark:bg-midnight-deep ring-1 ring-compute/25 rounded-2xl p-5 shadow-xl relative z-10"
            >
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-lg bg-compute/15 flex items-center justify-center">
                    <Lock :size="16" class="text-compute" />
                  </div>
                  <span class="text-base font-semibold text-white">Fhenix FHE Encryption</span>
                </div>
                <MBadge variant="fhe">CoFHE</MBadge>
              </div>
              <div class="font-mono text-sm space-y-1.5">
                <p class="text-compute">FHE.asEuint128(amount)</p>
                <p class="text-signal">FHE.allow(handle, owner)</p>
                <p class="text-gold">FHE.select(cond, val, zero)</p>
              </div>
              <!-- Pulsing ring effect -->
              <div class="absolute -inset-px rounded-2xl ring-1 ring-compute/20" style="animation: pulse-ring 3s ease-in-out infinite" />
            </div>

            <!-- Animated flow line 2 -->
            <div
              v-motion
              :initial="{ opacity: 0, scaleY: 0 }"
              :enter="{ opacity: 1, scaleY: 1, transition: { delay: 1500, duration: 500 } }"
              class="w-px h-10 bg-gradient-to-b from-compute/30 via-compute/20 to-signal/30 relative z-0 origin-top"
            >
              <div class="flow-dot absolute left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-signal" style="animation: flow-down 2s ease-in-out infinite; animation-delay: -1s" />
              <div class="absolute bottom-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-signal/50" />
            </div>

            <!-- Stage 3: Encrypted output -->
            <div
              v-motion
              :initial="{ opacity: 0, y: 30 }"
              :enter="{ opacity: 1, y: 0, transition: { delay: 1700, duration: 700 } }"
              class="w-full bg-white/90 dark:bg-midnight-mid/90 ring-1 ring-compute/20 rounded-2xl p-5 shadow-lg relative z-10"
            >
              <div class="flex items-center gap-2.5 mb-3">
                <div class="w-8 h-8 rounded-lg bg-compute/10 flex items-center justify-center">
                  <EyeOff :size="16" class="text-compute" />
                </div>
                <span class="text-base font-semibold text-midnight dark:text-white">Encrypted On-Chain</span>
              </div>
              <div class="font-mono text-sm text-compute/70 space-y-1">
                <p>balance: <span class="text-compute font-medium">euint128(******)</span></p>
                <p>yield: <span class="text-compute font-medium">euint128(******)</span></p>
              </div>
              <div class="flex items-center gap-2 mt-3">
                <Shield :size="12" class="text-compute" />
                <span class="text-sm text-cool">Only you can decrypt via EIP-712</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Mobile hero cards -->
        <div class="lg:hidden flex flex-col items-center gap-4">
          <div class="w-[85%] bg-white dark:bg-midnight-mid ring-1 ring-haze/30 dark:ring-white/8 rounded-2xl p-5 shadow-2xl relative">
            <div class="absolute -inset-8 bg-[radial-gradient(circle,var(--color-compute)_/_8%,transparent_60%)] pointer-events-none" />
            <p class="text-sm uppercase tracking-wider text-cool font-medium mb-1">Total Portfolio Value</p>
            <p class="text-2xl font-accent italic text-midnight dark:text-white tabular-nums">$51,247.83</p>
            <div class="flex items-center gap-2 mt-2">
              <MBadge variant="positive">+2.3%</MBadge>
            </div>
            <div class="flex gap-1 mt-3">
              <div class="h-1.5 rounded-full bg-compute" style="width: 70%" />
              <div class="h-1.5 rounded-full bg-midnight dark:bg-signal" style="width: 20%" />
              <div class="h-1.5 rounded-full bg-cipher" style="width: 10%" />
            </div>
          </div>
          <div class="w-[75%] -mt-3 bg-midnight dark:bg-midnight-deep ring-1 ring-signal/20 rounded-2xl p-4 shadow-lg z-10">
            <div class="flex items-center gap-2 mb-2">
              <Lock :size="12" class="text-signal" />
              <span class="text-[11px] font-mono text-signal uppercase tracking-widest">FHE Encrypted</span>
            </div>
            <div class="font-mono text-sm text-signal/70 space-y-1">
              <p>balance: <span class="text-signal">euint128(******)</span></p>
              <p>yields:&nbsp; <span class="text-signal">euint128(******)</span></p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ━━━ POWERED BY BAR ━━━ -->
    <section class="bg-midnight dark:bg-midnight-deep">
      <div class="max-w-5xl mx-auto px-6 py-6 flex items-center justify-center gap-10 md:gap-16 flex-wrap">
        <span
          v-for="(tech, i) in ['FHENIX', 'ARBITRUM', 'CoFHE', 'ERC-3643', 'ReineiraOS']"
          :key="tech"
          v-motion
          :initial="{ opacity: 0, y: 10 }"
          :visible-once="{ opacity: 1, y: 0, transition: { delay: i * 100 } }"
          class="text-sm md:text-base font-mono font-semibold text-white/70 uppercase tracking-[0.2em]"
        >
          {{ tech }}
        </span>
      </div>
    </section>

    <!-- ━━━ STATS STRIP ━━━ -->
    <section class="py-16 lg:py-20 relative">
      <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--color-compute)_/_6%,transparent_70%)] pointer-events-none" />
      <div class="relative max-w-5xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
        <div
          v-for="(stat, i) in LANDING_STATS"
          :key="i"
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :visible-once="{ opacity: 1, y: 0, transition: { delay: i * 100, duration: 500 } }"
          class="bg-white/70 dark:bg-midnight-mid/50 rounded-2xl px-6 py-6 border-t-[3px] border-compute"
        >
          <component :is="statIcons[i]" :size="20" class="text-compute mx-auto mb-3" />
          <p :ref="(el) => { if (el) statRefs[i].target.value = el as HTMLElement }" class="text-4xl md:text-5xl font-sans font-extrabold text-midnight dark:text-white tabular-nums">
            {{ stat.prefix }}{{ statRefs[i].displayValue.value }}<span v-if="stat.suffix" class="font-normal text-cool">{{ stat.suffix }}</span>
          </p>
          <p class="text-base text-cool mt-2 font-medium uppercase tracking-wider">{{ stat.label }}</p>
        </div>
      </div>
    </section>

    <div class="h-px bg-gradient-to-r from-transparent via-haze/40 to-transparent" />

    <!-- ━━━ BEFORE vs AFTER ━━━ -->
    <section id="privacy" class="py-20 md:py-28 lg:py-36 scroll-mt-24">
      <div class="max-w-6xl mx-auto px-6">
        <div v-motion v-bind="sectionMotion">
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold text-center tracking-tight leading-[1.1] text-midnight dark:text-white mb-4">
            The Privacy Problem
          </h2>
          <p class="text-center text-xl text-slate dark:text-cool max-w-2xl mx-auto mt-2 mb-10 lg:mb-14">
            Traditional RWA platforms expose everything. MuHaven encrypts everything.
          </p>
        </div>

        <div class="grid md:grid-cols-2 gap-6 relative">
          <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 md:hidden">
            <div class="bg-midnight text-signal rounded-full w-10 h-10 flex items-center justify-center text-sm font-bold shadow-lg">VS</div>
          </div>

          <!-- Before -->
          <div v-motion v-bind="slideLeft(200)" class="bg-white dark:bg-midnight-mid border-2 border-negative/15 rounded-2xl p-8 shadow-lg shadow-negative/5">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-10 h-10 rounded-xl bg-negative/10 flex items-center justify-center">
                <Eye :size="20" class="text-negative" />
              </div>
              <div>
                <h3 class="font-sans font-bold text-xl text-midnight dark:text-white">Transparent RWA Platforms</h3>
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
                class="flex items-start gap-2.5 text-base text-slate dark:text-cool"
              >
                <span class="text-negative mt-0.5">&#10007;</span>
                <span>{{ item }}</span>
              </li>
            </ul>
            <div class="mt-5 bg-frost dark:bg-midnight rounded-lg p-4 font-mono text-sm text-negative/80 shadow-inner">
              balance[0x7a3f] = <span class="text-negative font-bold">51,247.83 USDC</span> // public
            </div>
          </div>

          <!-- After -->
          <div v-motion v-bind="slideRight(200)" class="bg-white dark:bg-midnight-mid border-2 border-compute/15 rounded-2xl p-8 shadow-lg shadow-compute/5">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-10 h-10 rounded-xl bg-compute/10 flex items-center justify-center">
                <EyeOff :size="20" class="text-compute" />
              </div>
              <div>
                <h3 class="font-sans font-bold text-xl text-midnight dark:text-white">MuHaven + Fhenix FHE</h3>
                <p class="text-sm text-cool">Encrypted by default</p>
              </div>
            </div>
            <ul class="space-y-3">
              <li
                v-for="(item, i) in [
                  'Balances encrypted as euint128 on-chain',
                  'Yield computed in ciphertext via FHE.div()',
                  'AI agent operates on encrypted state only',
                  'Only the investor can decrypt via EIP-712 permit',
                ]"
                :key="item"
                v-motion
                :initial="{ opacity: 0, x: 20 }"
                :visible-once="{ opacity: 1, x: 0, transition: { delay: 300 + i * 100, duration: 400 } }"
                class="flex items-start gap-2.5 text-base text-slate dark:text-cool"
              >
                <span class="text-compute mt-0.5">&#10003;</span>
                <span>{{ item }}</span>
              </li>
            </ul>
            <div class="mt-5 bg-frost dark:bg-midnight rounded-lg p-4 font-mono text-sm text-compute/80 shadow-inner">
              balance[0x7a3f] = <span class="text-compute font-bold">euint128(******)</span> // encrypted
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="h-px bg-gradient-to-r from-transparent via-haze/40 to-transparent" />

    <!-- ━━━ FEATURES GRID ━━━ -->
    <section id="features" ref="featuresSection" class="py-20 md:py-28 lg:py-36 bg-white/60 dark:bg-midnight-mid/40 backdrop-blur-sm scroll-mt-24">
      <div class="max-w-6xl mx-auto px-6">
        <div v-motion v-bind="sectionMotion">
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold text-center tracking-tight leading-[1.1] text-midnight dark:text-white mb-4">
            Three Layers of Privacy
          </h2>
          <p class="text-center text-xl text-slate dark:text-cool max-w-2xl mx-auto mt-2 mb-10 lg:mb-14">
            Balance privacy, yield privacy, and AI privacy — solved together because solving them separately would be architecturally incomplete.
          </p>
        </div>

        <div class="grid md:grid-cols-3 gap-8">
          <div
            v-for="(feat, i) in LANDING_FEATURES"
            :key="i"
            v-motion
            v-bind="staggerDelay(i)"
            class="bg-white dark:bg-midnight-mid ring-1 ring-haze/30 dark:ring-white/6 rounded-xl p-7 shadow-lg shadow-compute/5 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-xl hover:shadow-compute/10 hover:ring-compute/20 cursor-pointer group"
          >
            <div class="w-12 h-12 rounded-xl bg-compute/10 flex items-center justify-center mb-5 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-110">
              <component :is="featureIcons[feat.icon]" :size="24" class="text-compute" />
            </div>
            <h3 class="text-xl font-sans font-bold text-midnight dark:text-white mb-3">
              {{ feat.title }}
            </h3>
            <p class="text-base text-slate dark:text-cool leading-relaxed mb-5">
              {{ feat.description }}
            </p>
            <div class="bg-frost dark:bg-midnight rounded-lg px-4 py-3 font-mono text-sm text-compute">
              {{ feat.code }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ━━━ CODE SNIPPET SECTION ━━━ -->
    <section id="how-it-works" class="py-20 md:py-28 lg:py-36 bg-midnight-deep relative scroll-mt-24">
      <div class="max-w-6xl mx-auto px-6 grid lg:grid-cols-2 gap-12 items-center">
        <div v-motion v-bind="sectionMotion">
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold tracking-tight leading-[1.1] text-white mb-4">
            FHE Operations On-Chain
          </h2>
          <p class="text-xl text-cool leading-relaxed mb-8">
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

        <div v-motion v-bind="scaleIn(150)" class="bg-black/30 rounded-2xl ring-1 ring-white/5 overflow-hidden shadow-elevated">
          <div class="flex items-center gap-2 px-5 py-3.5 border-b border-white/5">
            <div class="w-3 h-3 rounded-full bg-negative/60" />
            <div class="w-3 h-3 rounded-full bg-gold/60" />
            <div class="w-3 h-3 rounded-full bg-compute/60" />
            <span class="ml-3 text-sm font-mono text-cool/50">MuHavenToken.sol</span>
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
                line.color === 'compute' ? 'text-compute'
                  : line.color === 'signal' ? 'text-signal'
                  : line.color === 'gold' ? 'text-gold'
                  : line.color === 'cipher' ? 'text-cipher'
                  : line.color === 'cool' ? 'text-cool/60'
                  : 'text-white/80',
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
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold text-center tracking-tight leading-[1.1] text-midnight dark:text-white mb-4">
            Two-Sided Platform
          </h2>
          <p class="text-center text-xl text-slate dark:text-cool max-w-2xl mx-auto mt-2 mb-10 lg:mb-14">
            Issuers create RWA tokens and deposit yield. Investors buy tokens and earn yield privately. Both sides share the same encrypted contracts.
          </p>
        </div>

        <div class="grid md:grid-cols-2 gap-8">
          <!-- Investor flow -->
          <div v-motion v-bind="slideLeft(200)" class="bg-white dark:bg-midnight-mid ring-1 ring-haze/30 dark:ring-white/6 rounded-xl p-7 shadow-lg shadow-compute/5 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-xl hover:shadow-compute/10 hover:ring-compute/20 cursor-pointer group">
            <div class="flex items-center gap-3 mb-6">
              <div class="w-10 h-10 rounded-xl bg-compute/10 flex items-center justify-center transition-transform duration-300 group-hover:rotate-[-8deg] group-hover:scale-110">
                <Shield :size="20" class="text-compute" />
              </div>
              <h3 class="font-sans font-bold text-xl text-midnight dark:text-white">Investors</h3>
            </div>
            <div class="space-y-4">
              <div v-for="(step, i) in [
                'Deposit USDC via encrypted payment rails',
                'AI agent recommends portfolio allocation',
                'Buy fhERC-20 RWA tokens (encrypted balances)',
                'Receive yield privately — only you can decrypt',
              ]" :key="i" class="flex items-start gap-3">
                <div class="w-7 h-7 rounded-full bg-compute/10 text-compute flex items-center justify-center text-sm font-bold shrink-0 mt-0.5">
                  {{ i + 1 }}
                </div>
                <p class="text-base text-slate dark:text-cool">{{ step }}</p>
              </div>
            </div>
          </div>

          <!-- Issuer flow -->
          <div v-motion v-bind="slideRight(200)" class="bg-white dark:bg-midnight-mid ring-1 ring-haze/30 dark:ring-white/6 rounded-xl p-7 shadow-lg shadow-compute/5 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-xl hover:shadow-gold/10 hover:ring-gold/20 cursor-pointer group">
            <div class="flex items-center gap-3 mb-6">
              <div class="w-10 h-10 rounded-xl bg-gold/10 flex items-center justify-center transition-transform duration-300 group-hover:rotate-[-8deg] group-hover:scale-110">
                <TrendingUp :size="20" class="text-gold" />
              </div>
              <h3 class="font-sans font-bold text-xl text-midnight dark:text-white">Issuers</h3>
            </div>
            <div class="space-y-4">
              <div v-for="(step, i) in [
                'Create fhERC-20 RWA token or wrap existing ERC-20',
                'Configure KYC requirements and jurisdiction rules',
                'Deposit yield into YieldDistributor contract',
                'Yield distributed proportionally via FHE math',
              ]" :key="i" class="flex items-start gap-3">
                <div class="w-7 h-7 rounded-full bg-gold/10 text-gold flex items-center justify-center text-sm font-bold shrink-0 mt-0.5">
                  {{ i + 1 }}
                </div>
                <p class="text-base text-slate dark:text-cool">{{ step }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="h-px bg-gradient-to-r from-transparent via-haze/40 to-transparent" />

    <!-- ━━━ FAQ ━━━ -->
    <section id="faq" class="py-20 md:py-28 lg:py-36 bg-white/60 dark:bg-midnight-mid/40 backdrop-blur-sm scroll-mt-24">
      <div class="max-w-3xl mx-auto px-6">
        <div v-motion v-bind="sectionMotion">
          <h2 class="text-4xl lg:text-5xl font-sans font-extrabold text-center tracking-tight leading-[1.1] text-midnight dark:text-white mb-4">
            Frequently Asked Questions
          </h2>
          <p class="text-center text-xl text-slate dark:text-cool mt-2 mb-10 lg:mb-14">
            Common questions about privacy, FHE, and how MuHaven works.
          </p>
        </div>
        <MAccordion :items="LANDING_FAQ" />
      </div>
    </section>

    <div class="h-px bg-gradient-to-r from-transparent via-haze/40 to-transparent" />

    <!-- ━━━ CTA ━━━ -->
    <section class="py-20 md:py-28 lg:py-36">
      <div class="max-w-4xl mx-auto px-6">
        <div
          v-motion v-bind="scaleIn()"
          class="bg-midnight dark:bg-midnight-mid rounded-3xl p-10 md:p-16 text-center ring-1 ring-signal/10 relative overflow-hidden"
        >
          <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--color-compute)_/_15%,var(--color-midnight)_70%)]" />
          <div class="absolute w-32 h-32 rounded-full bg-compute/4 blur-3xl top-8 left-1/4" style="animation: drift 25s infinite alternate ease-in-out" />
          <div class="absolute w-24 h-24 rounded-full bg-signal/4 blur-3xl bottom-12 right-1/4" style="animation: drift 20s infinite alternate ease-in-out; animation-delay: -8s" />
          <div class="absolute w-20 h-20 rounded-full bg-cipher/4 blur-3xl top-1/2 right-1/3" style="animation: drift 30s infinite alternate ease-in-out; animation-delay: -15s" />

          <div class="relative">
            <h2 class="text-3xl md:text-4xl font-sans font-extrabold text-white mb-4">
              Start Managing Your Portfolio Privately
            </h2>
            <p class="text-xl text-cool max-w-xl mx-auto mb-8">
              Encrypted balances, private yields, AI-powered management. Nobody sees your strategy — not even the agent.
            </p>
            <div class="flex flex-wrap items-center justify-center gap-4 mb-6">
              <MButton size="lg" class="btn-shimmer" @click="router.push('/portfolio')">
                Launch App
                <ArrowRight :size="16" />
              </MButton>
              <MButton variant="outline" size="lg" class="border-white/20 text-white hover:border-signal hover:text-signal dark:border-white/20 dark:text-white dark:hover:border-signal dark:hover:text-signal">
                <Github :size="16" />
                GitHub
              </MButton>
              <MButton variant="outline" size="lg" class="border-white/20 text-white hover:border-signal hover:text-signal dark:border-white/20 dark:text-white dark:hover:border-signal dark:hover:text-signal">
                <ExternalLink :size="16" />
                Etherscan
              </MButton>
            </div>
            <p class="text-base text-cool/70">No KYC required &middot; Testnet live now</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Final one-liner CTA -->
    <div class="text-center py-8">
      <p class="text-base text-cool">
        Ready to go private?
        <button class="text-compute hover:text-compute-hover font-semibold ml-1 cursor-pointer" @click="router.push('/portfolio')">
          Launch App &rarr;
        </button>
      </p>
    </div>

    <!-- ━━━ FOOTER ━━━ -->
    <footer class="border-t border-haze/50 dark:border-white/5 py-8">
      <div class="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
        <div class="flex items-center gap-2.5">
          <img src="/logo.jpg" alt="MuHaven" class="w-6 h-6 rounded-md" style="mix-blend-mode: multiply" />
          <span class="text-base font-sans font-semibold text-midnight dark:text-white">MuHaven</span>
        </div>
        <p class="text-sm text-cool">
          Built with Fhenix FHE. Privacy is not a feature — it's the architecture.
        </p>
      </div>
    </footer>

    <!-- Mobile sticky CTA -->
    <Transition name="sticky-cta">
      <div
        v-if="showStickyCTA"
        class="fixed bottom-0 left-0 right-0 p-4 bg-frost/80 dark:bg-midnight/80 backdrop-blur-xl border-t border-haze/20 dark:border-white/5 z-40 md:hidden"
      >
        <MButton size="lg" class="w-full btn-shimmer" @click="router.push('/portfolio')">
          Launch App
          <ArrowRight :size="16" />
        </MButton>
      </div>
    </Transition>
  </div>
</template>
