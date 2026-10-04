<script setup lang="ts">
import type { GroupTracks } from "@cameld/shared";
import Message from "primevue/message";
import { computed, onMounted, ref } from "vue";
import { apiGet, errorText } from "../api.ts";
import { APP_COLOR, FITBIT_COLOR, MERGED_COLOR, type MapLine } from "../map.ts";
import TrackMap from "./TrackMap.vue";

/**
 * Side-by-side and overlay comparison of a group's tracks: the phone and
 * wrist originals from their backed-up files and the merge (the stored
 * merged FIT once built, else the server's in-memory preview). Used by the
 * review queue and the history detail.
 */
const props = defineProps<{ groupId: string; styleUrl: string | null }>();

const tracks = ref<GroupTracks | null>(null);
const error = ref<string | null>(null);
const show = ref({ app: true, fitbit: true, merged: true });

const mergedLabel = computed(() => tracks.value?.merged?.label ?? "merge");
const hidden = computed(() =>
  (["app", "fitbit", "merged"] as const).filter((id) => !show.value[id]),
);

const lines = computed(() => {
  const t = tracks.value as GroupTracks;
  const app: MapLine = { id: "app", line: t.app, color: APP_COLOR, dashed: false };
  const fitbit: MapLine = { id: "fitbit", line: t.fitbit, color: FITBIT_COLOR, dashed: false };
  const merged: MapLine = { id: "merged", line: t.merged, color: MERGED_COLOR, dashed: true };
  return { app: [app], fitbit: [fitbit], overlay: [app, fitbit, merged] };
});

onMounted(async () => {
  try {
    tracks.value = await apiGet<GroupTracks>(
      `/api/groups/${encodeURIComponent(props.groupId)}/tracks`,
    );
  } catch (e) {
    error.value = errorText(e);
  }
});
</script>

<template>
  <div class="comparison" data-testid="track-comparison">
    <Message v-if="error" severity="error" data-testid="tracks-error">{{ error }}</Message>
    <p v-else-if="tracks === null">Loading tracks...</p>
    <template v-else>
      <div class="maps">
        <figure>
          <figcaption>Phone (app)</figcaption>
          <TrackMap :lines="lines.app" :style-url="styleUrl" testid="map-side-app" />
        </figure>
        <figure>
          <figcaption>Wrist (Fitbit)</figcaption>
          <TrackMap :lines="lines.fitbit" :style-url="styleUrl" testid="map-side-fitbit" />
        </figure>
      </div>
      <figure>
        <figcaption class="legend">
          <label>
            <input v-model="show.app" type="checkbox" data-testid="toggle-app" />
            <i class="swatch app"></i>phone
          </label>
          <label>
            <input v-model="show.fitbit" type="checkbox" data-testid="toggle-fitbit" />
            <i class="swatch fitbit"></i>wrist
          </label>
          <label>
            <input v-model="show.merged" type="checkbox" data-testid="toggle-merged" />
            <i class="swatch merged"></i>{{ mergedLabel }}
          </label>
        </figcaption>
        <TrackMap
          :lines="lines.overlay"
          :style-url="styleUrl"
          :hidden="hidden"
          testid="map-overlay"
        />
      </figure>
      <ul v-if="tracks.notes.length > 0" class="notes" data-testid="track-notes">
        <li v-for="n in tracks.notes" :key="n">{{ n }}</li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.comparison {
  display: grid;
  gap: 1rem;
  min-width: 0;
}
.maps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 1rem;
}
figure {
  margin: 0;
  min-width: 0;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  margin-bottom: 0.35rem;
}
.legend label {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  cursor: pointer;
}
.swatch {
  display: inline-block;
  width: 1.5rem;
  height: 0.25rem;
  vertical-align: middle;
}
.swatch.app {
  background: #2563eb;
}
.swatch.fitbit {
  background: #ea580c;
}
.swatch.merged {
  border-top: 0.25rem dashed #16a34a;
  height: 0;
}
</style>
