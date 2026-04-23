<script setup lang="ts">
withDefaults(
  defineProps<{
    label?: string
    caption?: string
  }>(),
  {
    label: 'Loading',
    caption: '',
  },
)
</script>

<template>
  <div
    class="flex flex-col items-center justify-center gap-6 min-h-[calc(100vh-10rem)]"
    role="status"
    aria-live="polite"
  >
    <div class="relative flex items-center justify-center">
      <div aria-hidden="true" class="loader-halo absolute inset-0 -m-4 rounded-full" />
      <img
        src="/logo.png"
        alt=""
        aria-hidden="true"
        class="loader-logo w-14 h-14 rounded-xl relative z-10
               mix-blend-multiply dark:mix-blend-normal
               dark:drop-shadow-[0_0_18px_rgba(255,186,32,0.55)]"
      />
    </div>

    <div class="flex flex-col items-center gap-1.5 text-center">
      <p class="font-accent italic text-xl md:text-2xl text-midnight dark:text-white tracking-tight">
        <span>{{ label }}</span><span class="loader-dots" aria-hidden="true" />
      </p>
      <p v-if="caption" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool">
        {{ caption }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.loader-logo {
  animation: loader-breathe 2.6s ease-in-out infinite;
}

.loader-halo {
  background: radial-gradient(
    circle at center,
    rgba(255, 186, 32, 0.22) 0%,
    rgba(255, 220, 161, 0.10) 45%,
    transparent 72%
  );
  animation: loader-halo 2.6s ease-in-out infinite;
}
:global(.dark) .loader-halo {
  background: radial-gradient(
    circle at center,
    rgba(255, 220, 161, 0.28) 0%,
    rgba(255, 186, 32, 0.14) 45%,
    transparent 72%
  );
}

.loader-dots::after {
  content: '';
  display: inline-block;
  width: 1.6em;
  text-align: left;
  animation: loader-ellipsis 1.4s steps(4, end) infinite;
}

@keyframes loader-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.06); }
}

@keyframes loader-halo {
  0%, 100% { opacity: 0.65; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.18); }
}

@keyframes loader-ellipsis {
  0%   { content: ''; }
  25%  { content: '.'; }
  50%  { content: '..'; }
  75%  { content: '...'; }
}

@media (prefers-reduced-motion: reduce) {
  .loader-logo, .loader-halo { animation: none; }
  .loader-dots::after { content: '...'; animation: none; }
}
</style>
