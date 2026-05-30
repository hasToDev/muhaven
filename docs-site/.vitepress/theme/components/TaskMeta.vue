<script setup lang="ts">
/**
 * TaskMeta — the metadata strip at the top of every Testing-Guide task page.
 *
 * Renders: ⏱ time · 👤 role · 🔗 needs (prerequisites).
 *
 * Usage in markdown:
 *   <TaskMeta time="~3 min" role="Investor" needs="Signed in · some mhUSDC" />
 *
 * Accessibility: it's a `<dl>` so each label/value pair is programmatically
 * associated; the emoji glyphs are decorative (aria-hidden) and each term has
 * a real text label for screen readers. dt/dd use text-1/text-2 (both clear
 * AA on the bg-alt strip).
 */
defineProps<{
  time?: string
  role?: string
  needs?: string
}>()
</script>

<template>
  <dl class="mh-taskmeta">
    <div v-if="time" class="mh-taskmeta__item">
      <dt><span aria-hidden="true">⏱</span> Time</dt>
      <dd>{{ time }}</dd>
    </div>
    <div v-if="role" class="mh-taskmeta__item">
      <dt><span aria-hidden="true">👤</span> Role</dt>
      <dd>{{ role }}</dd>
    </div>
    <div v-if="needs" class="mh-taskmeta__item">
      <dt><span aria-hidden="true">🔗</span> Needs</dt>
      <dd>{{ needs }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.mh-taskmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  margin: 16px 0 24px;
  padding: 0;
}

.mh-taskmeta__item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  padding: 6px 12px;
  border: 1px solid var(--vp-c-border);
  border-radius: 999px;
  background: var(--vp-c-bg-alt);
  font-size: 13px;
}

.mh-taskmeta__item dt {
  margin: 0;
  font-weight: 600;
  color: var(--vp-c-text-2);
  white-space: nowrap;
}

.mh-taskmeta__item dd {
  margin: 0;
  color: var(--vp-c-text-1);
  font-weight: 500;
}
</style>
