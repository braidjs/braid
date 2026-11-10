<script setup lang="ts">
import { computed } from 'vue';

/**
 * A mock browser window for the guides: a tab strip, an address bar, and whatever the page holds.
 * Purely illustrative — nothing inside is live — and drawn from the theme's own colors, so it
 * follows light and dark mode.
 */
const props = defineProps<{
  /** The address shown, without the scheme. */
  url: string;
  /** Tab titles, comma-separated. The first is the active one unless `active` says otherwise. */
  tabs?: string;
  active?: number | string;
  /** A line under the window saying what the picture shows. */
  caption?: string;
}>();

const titles = computed(() => (props.tabs ?? '').split(',').map((tab) => tab.trim()).filter(Boolean));
const current = computed(() => Number(props.active ?? 0));
</script>

<template>
  <figure class="bm" role="group" :aria-label="caption ?? `Mock browser window at ${url}`">
    <div class="bm-window">
      <div class="bm-chrome" aria-hidden="true">
        <span class="bm-dots"><i></i><i></i><i></i></span>
        <span v-for="(title, index) in titles" :key="title" class="bm-tab" :class="{ 'is-active': index === current }">{{ title }}</span>
      </div>
      <div class="bm-address" aria-hidden="true">
        <span class="bm-nav">‹ › ↻</span>
        <span class="bm-url"><span class="bm-lock">🔒</span>{{ url }}</span>
      </div>
      <div class="bm-page"><slot /></div>
    </div>
    <figcaption v-if="caption">{{ caption }}</figcaption>
  </figure>
</template>
