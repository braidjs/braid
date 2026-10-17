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

const id = `mermaid-${Math.random().toString(36).slice(2)}`;

async function render() {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark.value ? 'dark' : 'default',
  });
  svg.value = (await mermaid.render(id, decodeURIComponent(props.code))).svg;
}

onMounted(render);
watch(isDark, render);
</script>

<template>
  <div class="mermaid" v-html="svg"></div>
</template>
