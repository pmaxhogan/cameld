<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { applyHidden, createTrackMap, type MapLine } from "../map.ts";

const props = withDefaults(
  defineProps<{
    lines: MapLine[];
    styleUrl: string | null;
    testid: string;
    /** Ids of lines to hide (the comparison's toggles). */
    hidden?: string[];
  }>(),
  { hidden: () => [] },
);

const el = ref<HTMLElement | null>(null);
let map: ReturnType<typeof createTrackMap> | null = null;

onMounted(() => {
  try {
    map = createTrackMap(el.value as HTMLElement, props.styleUrl, props.lines, () => props.hidden);
  } catch (error) {
    // No WebGL (headless, old browser): the container stays as an empty panel.
    console.warn("map unavailable", error);
  }
});

watch(
  () => props.hidden,
  (hidden) => {
    if (map !== null) applyHidden(map, props.lines, hidden);
  },
);

onBeforeUnmount(() => {
  map?.remove();
  map = null;
});
</script>

<template>
  <div ref="el" class="track-map" :data-testid="testid"></div>
</template>

<style scoped>
.track-map {
  height: 18rem;
  width: 100%;
  border-radius: 0.5rem;
  background: #e5e7eb;
}
</style>
