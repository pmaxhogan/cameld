<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createTrackMap, type MapLine } from "../map.ts";

const props = defineProps<{ lines: MapLine[]; styleUrl: string | null; testid: string }>();

const el = ref<HTMLElement | null>(null);
let map: ReturnType<typeof createTrackMap> | null = null;

onMounted(() => {
  try {
    map = createTrackMap(el.value as HTMLElement, props.styleUrl, props.lines);
  } catch (error) {
    // No WebGL (headless, old browser): the container stays as an empty panel.
    console.warn("map unavailable", error);
  }
});

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
