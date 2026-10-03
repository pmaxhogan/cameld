<script setup lang="ts">
import type { GroupSummary, GroupTracks, ReviewDecision, ReviewItem } from "@cameld/shared";
import Button from "primevue/button";
import Message from "primevue/message";
import Textarea from "primevue/textarea";
import { computed, onMounted, ref } from "vue";
import { apiGet, apiPost, errorText } from "../api.ts";
import TrackMap from "../components/TrackMap.vue";
import { readMetrics } from "../format.ts";
import { APP_COLOR, FITBIT_COLOR, MERGED_COLOR, type MapLine } from "../map.ts";
import { groupHref } from "../router.ts";

const props = defineProps<{ item: ReviewItem; styleUrl: string | null }>();
const emit = defineEmits<{ decided: [summary: GroupSummary] }>();

const tracks = ref<GroupTracks | null>(null);
const tracksError = ref<string | null>(null);
const note = ref("");
const offset = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

const metrics = computed(() => readMetrics(props.item.match));

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
      `/api/groups/${encodeURIComponent(props.item.id)}/tracks`,
    );
  } catch (e) {
    tracksError.value = errorText(e);
  }
});

async function decide(decision: ReviewDecision["decision"]): Promise<void> {
  const body: ReviewDecision = { decision, note: note.value.trim() };
  if (offset.value.trim() !== "") {
    const seconds = Number(offset.value);
    if (!Number.isFinite(seconds)) {
      error.value = "Offset must be a number of seconds";
      return;
    }
    body.offsetSeconds = seconds;
  }
  busy.value = true;
  error.value = null;
  try {
    const summary = await apiPost<GroupSummary>(
      `/api/review/${encodeURIComponent(props.item.id)}`,
      body,
    );
    emit("decided", summary);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="detail" data-testid="review-detail">
    <h3>
      Group <a :href="groupHref(item.id)">{{ item.id }}</a>
    </h3>
    <Message v-if="tracksError" severity="error" data-testid="tracks-error">
      {{ tracksError }}
    </Message>
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
          <span><i class="swatch app"></i>app</span>
          <span><i class="swatch fitbit"></i>fitbit</span>
          <span><i class="swatch merged"></i>merge preview</span>
        </figcaption>
        <TrackMap :lines="lines.overlay" :style-url="styleUrl" testid="map-overlay" />
      </figure>
      <ul class="notes" data-testid="track-notes">
        <li v-for="n in tracks.notes" :key="n">{{ n }}</li>
      </ul>
    </template>

    <dl class="metrics" data-testid="review-metrics">
      <dt>Decision</dt>
      <dd>{{ metrics.decision }}</dd>
      <dt>Overlap</dt>
      <dd>{{ metrics.overlap }}</dd>
      <dt>Start delta</dt>
      <dd>{{ metrics.startDelta }}</dd>
      <dt>Median distance</dt>
      <dd>{{ metrics.median }}</dd>
      <dt>90th pct distance</dt>
      <dd>{{ metrics.p90 }}</dd>
      <dt>Clock alignment</dt>
      <dd>{{ metrics.alignStatus }}, offset {{ metrics.alignOffset }}</dd>
      <dt>Sharpness</dt>
      <dd>{{ metrics.sharpness }}</dd>
      <dt>Reasons</dt>
      <dd>{{ metrics.reasons.join(", ") }}</dd>
    </dl>

    <div class="decide">
      <label for="review-note">Note</label>
      <Textarea id="review-note" v-model="note" rows="2" data-testid="review-note" />
      <label for="review-offset">Clock offset on approve (seconds, optional)</label>
      <input
        id="review-offset"
        v-model="offset"
        type="text"
        inputmode="numeric"
        class="p-inputtext"
        data-testid="review-offset"
      />
      <Message v-if="error" severity="error" data-testid="review-decision-error">
        {{ error }}
      </Message>
      <div class="buttons">
        <Button
          label="Approve merge"
          severity="success"
          :disabled="busy"
          data-testid="approve-button"
          @click="decide('approve')"
        />
        <Button
          label="Reject"
          severity="secondary"
          :disabled="busy"
          data-testid="reject-button"
          @click="decide('reject')"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
}
.maps {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
figure {
  margin: 0;
}
.legend {
  display: flex;
  gap: 1rem;
}
.swatch {
  display: inline-block;
  width: 1.5rem;
  height: 0.25rem;
  margin-right: 0.35rem;
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
.metrics {
  display: grid;
  grid-template-columns: 10rem 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
}
.metrics dd {
  margin: 0;
}
.decide {
  display: grid;
  gap: 0.5rem;
  max-width: 32rem;
}
.buttons {
  display: flex;
  gap: 0.5rem;
}
</style>
