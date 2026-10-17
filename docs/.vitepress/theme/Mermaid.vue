<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';

/**
 * Renders one ```mermaid fence (see the fence rule in config.mts) on the client.
 *
 * Replaces vitepress-plugin-mermaid, whose peer range pinned both vitepress and mermaid a major
 * behind. Mermaid is imported lazily so it stays out of SSR and out of pages without diagrams, and
 * keeps its default `strict` security level — the plugin forced `loose`, which none of these
 * diagrams need.
 */
const props = defineProps<{ code: string }>();
const { isDark } = useData();
const svg = ref('');
const failed = ref(false);

// A fresh id per render: mermaid removes any element with the id it is given, which would
// otherwise delete the diagram on screen before a theme-toggle re-render finishes.
const id = `mermaid-${Math.random().toString(36).slice(2)}`;
let renders = 0;

async function render() {
  const { default: mermaid } = await import('mermaid');
  // suppressErrorRendering stops mermaid drawing its error graphic into <body>, outside this
  // component; a broken diagram shows its source here instead.
  mermaid.initialize({
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: isDark.value ? 'dark' : 'default',
  });
  try {
    svg.value = (
      await mermaid.render(`${id}-${renders++}`, decodeURIComponent(props.code))
    ).svg;
    failed.value = false;
  } catch (error) {
    console.error(error);
    failed.value = true;
  }
}

onMounted(render);
watch(isDark, render);
</script>

<template>
  <pre v-if="failed">{{ decodeURIComponent(props.code) }}</pre>
  <div v-else class="mermaid" v-html="svg"></div>
</template>
