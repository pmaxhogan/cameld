<script setup lang="ts">
import { parseHealth } from "@cameld/shared";
import Card from "primevue/card";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createMap } from "./map.ts";

const version = ref<string | null>(null);
const mapEl = ref<HTMLElement | null>(null);
let map: ReturnType<typeof createMap> | null = null;

onMounted(async () => {
  if (mapEl.value !== null) {
    try {
      map = createMap(mapEl.value);
    } catch (error) {
      // No WebGL (headless, old browser): the placeholder is optional.
      console.warn("map unavailable", error);
    }
  }
  try {
    const response = await fetch("/healthz");
    version.value = parseHealth(await response.json())?.version ?? null;
  } catch {
    version.value = null;
  }
});

onBeforeUnmount(() => {
  map?.remove();
  map = null;
});
</script>

<template>
  <main class="shell">
    <h1>cameld</h1>
    <Card>
      <template #title>Status</template>
      <template #content>
        <p data-testid="version">
          {{ version === null ? "server unreachable" : `server ${version}` }}
        </p>
      </template>
    </Card>
    <div ref="mapEl" class="map" data-testid="map"></div>
  </main>
</template>

<style scoped>
.shell {
  max-width: 60rem;
  margin: 0 auto;
  padding: 1rem;
  display: grid;
  gap: 1rem;
}
.map {
  height: 20rem;
  border-radius: 0.5rem;
  background: #e5e7eb;
}
</style>
