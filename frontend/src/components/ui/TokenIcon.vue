<script setup lang="ts">
import { computed, ref } from 'vue'
import { resolveTokenIconUrl, tokenMonogram } from '@/lib/tokenIcon'

/**
 * Token icon with a graceful monogram fallback.
 *
 * Renders the token's baked, same-origin icon (from
 * `public/token-icons/`, resolved via the generated manifest) so the COEP
 * `require-corp` header doesn't block it — see `@/lib/tokenIcon`. When no
 * icon is baked for the ticker, or the bytes fail to load at runtime
 * (`@error`), it falls back to a single-letter monogram on the same
 * neutral circle/rounded chip — never a broken-image glyph.
 *
 * `variant`:
 *  - `sm`   — 24px circle (inline field triggers / dense picker rows)
 *  - `card` — 40px circle (marketplace grid cards)
 *  - `hero` — 64px rounded square (token-detail hero)
 *
 * The icon is decorative: the ticker/name always sits adjacent in the DOM,
 * so both branches are hidden from assistive tech (`alt=""` /
 * `aria-hidden`).
 */
const props = withDefaults(
  defineProps<{ ticker: string; variant?: 'sm' | 'card' | 'hero' }>(),
  { variant: 'card' },
)

// Track WHICH ticker failed to load, not a bare boolean. Deriving the
// fallback from the ticker means a reused instance (token-detail
// navigation USYC → BUIDL) automatically re-attempts the new icon — no
// watch, no flush-timing race — and a load failure only suppresses the
// icon for the exact ticker that failed.
const failedTicker = ref<string | null>(null)

const src = computed(() => resolveTokenIconUrl(props.ticker))
const monogram = computed(() => tokenMonogram(props.ticker))
const showImage = computed(() => !!src.value && failedTicker.value !== props.ticker)

const shapeClass = computed(() =>
  props.variant === 'hero'
    ? 'w-16 h-16 rounded-2xl'
    : props.variant === 'sm'
      ? 'w-6 h-6 rounded-full'
      : 'w-10 h-10 rounded-full',
)
</script>

<template>
  <img
    v-if="showImage"
    :src="src!"
    alt=""
    loading="lazy"
    data-testid="token-icon-image"
    :class="[
      'object-contain flex-shrink-0 bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5',
      shapeClass,
    ]"
    @error="failedTicker = props.ticker"
  />
  <div
    v-else
    aria-hidden="true"
    data-testid="token-icon-monogram"
    :class="[
      'flex items-center justify-center flex-shrink-0 select-none font-sans font-bold uppercase',
      'bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5 text-slate dark:text-body-dark/80',
      shapeClass,
      variant === 'hero' ? 'text-2xl' : variant === 'sm' ? 'text-[10px]' : 'text-sm',
    ]"
  >{{ monogram }}</div>
</template>
