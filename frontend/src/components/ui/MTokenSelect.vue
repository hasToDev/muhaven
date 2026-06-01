<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { ChevronDown, Check, X } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import type { TokenResponseDto } from '@/services/api'
import TokenIcon from '@/components/ui/TokenIcon.vue'

/**
 * MTokenSelect — custom token picker that replaces the native `<select>` on
 * the Trade (buy / sell) and Transfer flows.
 *
 * Why it exists: a native `<select>`'s OS-rendered option dialog can't be
 * restyled — on Android it fills the screen top-to-bottom with a large-font
 * Material radio list, which read as "broken" at 411px (Wave 6 mobile round).
 * This component renders a styled trigger + a teleported, smaller-font,
 * capped-height scrollable list instead: a slide-up bottom-sheet at ≤768px,
 * an anchored dropdown at ≥768px.
 *
 * Contract: `modelValue` is the selected token **address** string — identical
 * to the old `<select v-model>` — so the host pages' buy/sell/transfer logic
 * is untouched. The trigger carries `testid` so the e2e selectors stay stable
 * (the rendered options expose `data-testid="token-option"`).
 *
 * Keep-alive note: both host pages live in App.vue's <keep-alive>. The picker
 * teleports to <body>, so it MUST close on deactivate or the overlay would
 * leak across pages (the documented teleport-leak regression class) — see
 * `onDeactivated` below.
 */
const props = withDefaults(
  defineProps<{
    /** Selected token address (v-model). Empty string = nothing selected. */
    modelValue: string
    /** Tokens to choose from (already filtered by the host). */
    options: TokenResponseDto[]
    /** Field label, also the picker's accessible name + mobile-sheet title. */
    label: string
    disabled?: boolean
    /** data-testid for the trigger (keeps e2e selectors stable). */
    testid: string
    /** Trade shows APY in the trigger + rows; Transfer does not. */
    showApy?: boolean
  }>(),
  { disabled: false, showApy: false },
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

// md breakpoint — bottom-sheet below, anchored dropdown at/above.
const isDesktop = useMediaQuery('(min-width: 768px)')

const open = ref(false)
const highlightedIndex = ref(-1)
const triggerRef = ref<HTMLButtonElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)

const listboxId = computed(() => `${props.testid}-listbox`)
const optionId = (i: number) => `${listboxId.value}-opt-${i}`

const selected = computed(() => props.options.find(o => o.address === props.modelValue))
const selectedIndex = computed(() => props.options.findIndex(o => o.address === props.modelValue))

function apyLabel(t: TokenResponseDto): string {
  return t.apy ? `${t.apy}% APY` : 'N/A'
}

// ── Desktop anchored-dropdown positioning ────────────────────────────────
// Teleported to body + position: fixed, so no parent `overflow-hidden` can
// clip it (the Transfer card IS overflow-hidden). Re-measured on scroll/resize
// while open so the dropdown tracks the trigger.
const pos = ref({ left: 0, width: 0, top: 0, bottom: 0, openUp: false, maxHeight: 320 })

const desktopStyle = computed(() => ({
  left: `${pos.value.left}px`,
  width: `${pos.value.width}px`,
  ...(pos.value.openUp ? { bottom: `${pos.value.bottom}px` } : { top: `${pos.value.top}px` }),
}))

function updatePosition() {
  const el = triggerRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const gap = 6
  const margin = 8
  const vh = window.innerHeight
  const spaceBelow = vh - r.bottom - margin
  const spaceAbove = r.top - margin
  const PREFERRED = 320
  // Flip up only when below is too cramped AND above has more room.
  const openUp = spaceBelow < Math.min(PREFERRED, 200) && spaceAbove > spaceBelow
  const avail = openUp ? spaceAbove : spaceBelow
  pos.value = {
    left: r.left,
    width: r.width,
    top: r.bottom + gap,
    bottom: vh - r.top + gap,
    openUp,
    maxHeight: Math.max(140, Math.min(PREFERRED, avail - gap)),
  }
}

let rafId = 0
function scheduleReposition() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    if (open.value && isDesktop.value) updatePosition()
  })
}
function attachReposition() {
  // capture: true also catches scrolls inside nested scroll containers.
  window.addEventListener('scroll', scheduleReposition, true)
  window.addEventListener('resize', scheduleReposition)
}
function detachReposition() {
  window.removeEventListener('scroll', scheduleReposition, true)
  window.removeEventListener('resize', scheduleReposition)
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

// ── Open / close / select ────────────────────────────────────────────────
async function openPicker() {
  if (props.disabled || !props.options.length) return
  // Measure BEFORE the panel paints so the desktop dropdown never flashes at
  // its stale/default position — the trigger is always mounted + measurable.
  if (isDesktop.value) updatePosition()
  open.value = true
  highlightedIndex.value = selectedIndex.value >= 0 ? selectedIndex.value : 0
  attachReposition()
  await nextTick()
  panelRef.value?.focus()
  scrollHighlightIntoView()
}

function close({ refocus = true }: { refocus?: boolean } = {}) {
  if (!open.value) return
  open.value = false
  detachReposition()
  if (refocus) nextTick(() => triggerRef.value?.focus())
}

function toggle() {
  if (props.disabled) return
  open.value ? close() : openPicker()
}

function selectToken(t: TokenResponseDto) {
  if (t.address !== props.modelValue) emit('update:modelValue', t.address)
  close()
}

// ── Keyboard (listbox + aria-activedescendant pattern) ───────────────────
function scrollHighlightIntoView() {
  const i = highlightedIndex.value
  if (i < 0) return
  nextTick(() => {
    // Optional method call: scrollIntoView is always present in the browser
    // but may be absent in the happy-dom unit-test environment.
    panelRef.value?.querySelector(`[data-index="${i}"]`)?.scrollIntoView?.({ block: 'nearest' })
  })
}
function setHighlight(i: number) {
  highlightedIndex.value = i
  scrollHighlightIntoView()
}
function move(delta: number) {
  const n = props.options.length
  if (!n) return
  setHighlight((highlightedIndex.value + delta + n) % n)
}
function onKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      e.preventDefault()
      move(-1)
      break
    case 'Home':
      e.preventDefault()
      setHighlight(0)
      break
    case 'End':
      e.preventDefault()
      setHighlight(props.options.length - 1)
      break
    case 'Enter':
    case ' ': {
      e.preventDefault()
      const t = props.options[highlightedIndex.value]
      if (t) selectToken(t)
      break
    }
    case 'Escape':
      e.preventDefault()
      close()
      break
    case 'Tab':
      close({ refocus: false })
      break
  }
}

function onTriggerKeydown(e: KeyboardEvent) {
  if (!open.value && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    openPicker()
  }
}

// Close if the field is disabled mid-open (e.g. a tx starts in flight).
watch(() => props.disabled, (d) => {
  if (d) close({ refocus: false })
})

// If the viewport crosses the md breakpoint while open WITHOUT firing a resize
// (rare — most MQ changes ride a resize that scheduleReposition already
// catches), re-anchor the desktop dropdown. Belt-and-suspenders.
watch(isDesktop, (desktop) => {
  if (open.value && desktop) updatePosition()
})

// Teleport-leak guard: the host pages are <keep-alive>d, so close (without
// stealing focus) when this page is backgrounded.
onDeactivated(() => close({ refocus: false }))
onBeforeUnmount(detachReposition)
</script>

<template>
  <div class="flex flex-col gap-3">
    <label
      :for="testid"
      class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium"
    >
      {{ label }}
    </label>

    <!-- Trigger — mirrors the old <select>'s bottom-border field look. -->
    <button
      :id="testid"
      ref="triggerRef"
      type="button"
      :data-testid="testid"
      :disabled="disabled"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listboxId : undefined"
      :class="cn(
        'w-full flex items-center gap-2.5 bg-transparent border-0 border-b py-3 pl-1 pr-2 text-left',
        'transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
        'text-midnight dark:text-white focus:outline-none',
        open
          ? 'border-gold dark:border-signal'
          : 'border-haze dark:border-white/10 focus-visible:border-gold dark:focus-visible:border-signal',
      )"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <TokenIcon v-if="selected" :ticker="selected.symbol" variant="sm" />
      <span class="flex-1 min-w-0 truncate font-sans text-sm md:text-base">
        <template v-if="selected">
          <span class="font-medium">{{ selected.symbol }}</span>
          <span class="text-cool"> · {{ selected.name }}</span>
        </template>
        <span v-else class="text-cool">Select…</span>
      </span>
      <span
        v-if="selected && showApy"
        class="shrink-0 font-sans text-xs tabular-nums text-cool"
      >{{ apyLabel(selected) }}</span>
      <ChevronDown
        :size="16"
        :stroke-width="1.6"
        class="shrink-0 text-cool transition-transform duration-200"
        :class="open && 'rotate-180'"
      />
    </button>

    <!-- Picker overlay: dropdown (≥768px) / bottom-sheet (≤768px). Teleported
         to body so no overflow-hidden ancestor clips it. -->
    <Teleport to="body">
      <Transition :name="isDesktop ? 'mts-pop' : 'mts-sheet'">
        <div
          v-if="open"
          class="fixed inset-0 z-[70]"
          :role="isDesktop ? undefined : 'dialog'"
          :aria-modal="isDesktop ? undefined : 'true'"
          :aria-label="isDesktop ? undefined : label"
        >
          <!-- Backdrop: dim on mobile, invisible (click-catcher) on desktop. -->
          <div
            class="absolute inset-0"
            :class="isDesktop ? '' : 'bg-midnight/50 backdrop-blur-sm'"
            aria-hidden="true"
            @click="close()"
          />

          <!-- Panel -->
          <div
            ref="panelRef"
            :id="listboxId"
            role="listbox"
            :aria-label="label"
            :aria-activedescendant="highlightedIndex >= 0 ? optionId(highlightedIndex) : undefined"
            tabindex="-1"
            :class="cn(
              'mts-panel bg-white dark:bg-[#1c1b1b] focus:outline-none',
              isDesktop
                ? 'fixed rounded-xl border border-haze dark:border-white/10 shadow-[0_18px_50px_-12px_rgba(63,46,12,0.28)] dark:shadow-[0_24px_70px_-20px_rgba(0,0,0,0.8)] overflow-hidden'
                : 'absolute bottom-0 left-0 right-0 rounded-t-2xl border-t border-haze dark:border-white/10 shadow-2xl',
            )"
            :style="isDesktop ? desktopStyle : undefined"
            @click.stop
            @keydown="onKeydown"
          >
            <!-- Mobile sheet header (grabber + title + close). -->
            <div
              v-if="!isDesktop"
              class="flex items-center justify-between px-4 pt-3 pb-2 border-b border-haze dark:border-white/8"
            >
              <span class="font-sans text-sm font-semibold text-midnight dark:text-white tracking-tight">
                {{ label }}
              </span>
              <button
                type="button"
                aria-label="Close"
                data-testid="token-select-close"
                class="w-8 h-8 -mr-1 rounded-lg flex items-center justify-center text-cool hover:bg-mist dark:hover:bg-white/5 transition-colors cursor-pointer"
                @click="close()"
              >
                <X :size="18" :stroke-width="2" />
              </button>
            </div>

            <!-- Option list (the scroller). Smaller font per the brief. -->
            <div
              class="px-1.5 py-1.5 overflow-y-auto overscroll-contain"
              :class="isDesktop ? '' : 'max-h-[60dvh] pb-[calc(0.5rem+env(safe-area-inset-bottom))]'"
              :style="isDesktop ? { maxHeight: `${pos.maxHeight}px` } : undefined"
            >
              <div
                v-for="(t, i) in options"
                :id="optionId(i)"
                :key="t.address"
                role="option"
                :aria-selected="t.address === modelValue"
                data-testid="token-option"
                :data-value="t.address"
                :data-index="i"
                :class="cn(
                  'flex items-center gap-3 px-2.5 py-2.5 rounded-lg cursor-pointer transition-colors',
                  i === highlightedIndex
                    ? 'bg-gold/12 dark:bg-signal/10'
                    : 'hover:bg-mist dark:hover:bg-white/5',
                )"
                @click="selectToken(t)"
                @mouseenter="highlightedIndex = i"
              >
                <TokenIcon :ticker="t.symbol" variant="sm" />
                <span class="flex-1 min-w-0">
                  <span class="block truncate font-sans text-sm font-medium text-midnight dark:text-white">
                    {{ t.symbol }}
                  </span>
                  <span class="block truncate font-sans text-xs text-cool">{{ t.name }}</span>
                </span>
                <span
                  v-if="showApy"
                  class="shrink-0 font-sans text-xs tabular-nums text-cool"
                >{{ apyLabel(t) }}</span>
                <Check
                  v-if="t.address === modelValue"
                  :size="16"
                  :stroke-width="2"
                  class="shrink-0 text-gold dark:text-signal"
                />
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* Mobile sheet: backdrop fades, panel slides up. Compositor-only. */
.mts-sheet-enter-active,
.mts-sheet-leave-active {
  transition: opacity 0.2s ease;
}
.mts-sheet-enter-active .mts-panel,
.mts-sheet-leave-active .mts-panel {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.mts-sheet-enter-from,
.mts-sheet-leave-to {
  opacity: 0;
}
.mts-sheet-enter-from .mts-panel,
.mts-sheet-leave-to .mts-panel {
  transform: translateY(100%);
}

/* Desktop dropdown: quick pop (the transparent overlay's opacity is moot). */
.mts-pop-enter-active,
.mts-pop-leave-active {
  transition: opacity 0.12s ease;
}
.mts-pop-enter-active .mts-panel,
.mts-pop-leave-active .mts-panel {
  transition: transform 0.14s ease, opacity 0.14s ease;
}
.mts-pop-enter-from .mts-panel,
.mts-pop-leave-to .mts-panel {
  transform: translateY(-4px);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .mts-sheet-enter-active,
  .mts-sheet-leave-active,
  .mts-sheet-enter-active .mts-panel,
  .mts-sheet-leave-active .mts-panel,
  .mts-pop-enter-active,
  .mts-pop-leave-active,
  .mts-pop-enter-active .mts-panel,
  .mts-pop-leave-active .mts-panel {
    transition: none;
  }
}
</style>
