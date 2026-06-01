<script setup lang="ts">
// Wave 6 Polish (A3) — ambient amber background wash: three blurred, slowly
// drifting balls. The drift is transform-only (compositor; reduced-motion-gated
// in global.css). Ball sizes step DOWN below `md` and the blur radius is lower
// on mobile (.mesh-ball in global.css) to shrink the offscreen Gaussian-blur
// buffer + the resident promoted-layer GPU memory on phones — the heaviest
// device class for large blur layers, and a constant cost on every page.
// The old `variant` prop ('hero'/'dark') was dead — the only mount is
// `<MMeshGradient />` in App.vue — so it was removed. See ADR-003.
</script>

<template>
  <div class="mesh-gradient" aria-hidden="true">
    <!-- Deep-amber ball — top left -->
    <div
      class="mesh-ball bg-compute w-[340px] h-[340px] md:w-[600px] md:h-[600px]
             -top-24 -left-24 md:-top-32 md:-left-32"
      style="animation-delay: 0s"
    />
    <!-- Cream-gold ball — bottom right -->
    <div
      class="mesh-ball bg-signal w-[300px] h-[300px] md:w-[500px] md:h-[500px]
             -bottom-24 -right-20 md:-bottom-32 md:-right-24"
      style="animation-delay: -7s"
    />
    <!-- Warm tertiary ball — center -->
    <div
      class="mesh-ball bg-cipher w-[260px] h-[260px] md:w-[400px] md:h-[400px]
             top-1/4 left-1/2"
      style="animation-delay: -14s"
    />
  </div>
</template>
