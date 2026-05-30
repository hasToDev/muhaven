<script setup lang="ts">
/**
 * ExpectedResult — the gold-bordered "this is what success looks like" block.
 *
 * Used at the end of every Testing-Guide task page so a judge has an
 * unambiguous pass/fail signal. Renders a labelled region (the slot content)
 * with an amber accent that maps to the Golden Hour palette.
 *
 * Usage in markdown:
 *   <ExpectedResult>
 *   The portfolio shows your new position …
 *   </ExpectedResult>
 *
 * Accessibility: it's a labelled `<section>` (region) so screen-reader users
 * can jump to it; the decorative check glyph is aria-hidden and the visible
 * "Expected result" label is the accessible name.
 */
defineProps<{ title?: string }>()
</script>

<template>
  <section class="mh-expected" role="region" :aria-label="title || 'Expected result'">
    <p class="mh-expected__label">
      <span class="mh-expected__check" aria-hidden="true">✓</span>
      {{ title || 'Expected result' }}
    </p>
    <div class="mh-expected__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.mh-expected {
  margin: 24px 0;
  padding: 16px 20px 4px;
  border: 1px solid var(--vp-c-brand-1);
  border-left-width: 4px;
  border-radius: 12px;
  background: var(--vp-c-brand-soft);
}

.mh-expected__label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  /* Brand-darker keeps the label readable on the soft amber wash in both
   * themes (the dark-mode override below lifts it to cream-gold). */
  color: var(--vp-c-brand-darker);
}

.dark .mh-expected__label {
  color: var(--vp-c-brand-1);
}

.mh-expected__check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  border-radius: 50%;
  color: var(--vp-c-bg);
  /* brand-darker (not brand-1) so the cream check on the amber chip clears
   * AA non-text contrast in light mode too. */
  background: var(--vp-c-brand-darker);
}

.dark .mh-expected__check {
  color: var(--mh-midnight);
  background: var(--vp-c-brand-1);
}

.mh-expected__body :first-child {
  margin-top: 0;
}

.mh-expected__body :deep(p),
.mh-expected__body :deep(ul),
.mh-expected__body :deep(ol) {
  font-size: 15px;
  line-height: 1.6;
}
</style>
