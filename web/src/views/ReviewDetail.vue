<script setup lang="ts">
import type { GroupSummary, ReviewDecision, ReviewItem } from "@cameld/shared";
import Button from "primevue/button";
import Message from "primevue/message";
import Textarea from "primevue/textarea";
import { computed, ref } from "vue";
import { apiPost, errorText } from "../api.ts";
import TrackComparison from "../components/TrackComparison.vue";
import { readMetrics } from "../format.ts";
import { groupTitle } from "../labels.ts";
import { groupHref } from "../router.ts";

const props = defineProps<{ item: ReviewItem; styleUrl: string | null }>();
const emit = defineEmits<{ decided: [summary: GroupSummary] }>();

const note = ref("");
const offset = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

const metrics = computed(() => readMetrics(props.item.match));

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
      <a :href="groupHref(item.id)">{{ groupTitle(item) }}</a>
      <small class="muted">{{ item.id }}</small>
    </h3>
    <TrackComparison :group-id="item.id" :style-url="styleUrl" />

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
  min-width: 0;
}
.muted {
  opacity: 0.7;
  font-size: 0.8rem;
  font-weight: normal;
  margin-left: 0.5rem;
  word-break: break-all;
}
.metrics {
  display: grid;
  grid-template-columns: minmax(7rem, 10rem) 1fr;
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
