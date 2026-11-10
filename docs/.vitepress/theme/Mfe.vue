<script setup lang="ts">
/**
 * One piece of a composed page in a mock browser: the host shell, or a fragment owned by a team.
 * The frame's style says what kind of boundary it is — solid for the host, dashed for a trusted
 * (same-origin) fragment, double for an untrusted (cross-origin) one.
 */
defineProps<{
  name: string;
  /** Who owns it, e.g. "Billing team". */
  team?: string;
  /** What it is built with, e.g. "React 19". */
  tech?: string;
  kind?: 'host' | 'trusted' | 'untrusted';
  /** Dimmed: not mounted yet, or gone. */
  absent?: boolean;
  /** A CSS `flex` value, to size it against its neighbours. */
  flex?: string;
}>();
</script>

<template>
  <section class="mfe" :class="[`mfe--${kind ?? 'trusted'}`, { 'is-absent': absent }]" :style="flex ? { flex } : undefined">
    <header class="mfe-head">
      <strong>{{ name }}</strong>
      <span v-if="tech" class="mfe-tag">{{ tech }}</span>
      <span v-if="team" class="mfe-tag mfe-tag--team">{{ team }}</span>
      <span v-if="kind === 'untrusted'" class="mfe-tag mfe-tag--warn">untrusted · cross-origin</span>
      <span v-if="absent" class="mfe-tag mfe-tag--warn">not mounted</span>
    </header>
    <div class="mfe-body"><slot /></div>
  </section>
</template>
