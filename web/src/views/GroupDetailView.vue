<script setup lang="ts">
import type { GroupDetail, RestoreResult } from "@cameld/shared";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Dialog from "primevue/dialog";
import Message from "primevue/message";
import Tag from "primevue/tag";
import Textarea from "primevue/textarea";
import Timeline from "primevue/timeline";
import { computed, onMounted, ref } from "vue";
import { apiGet, apiPost, errorText } from "../api.ts";
import { fmtTime, prettyJson, readMetrics, severityOf } from "../format.ts";

const props = defineProps<{ groupId: string }>();

const detail = ref<GroupDetail | null>(null);
const error = ref<string | null>(null);
const restoreOpen = ref(false);
const reason = ref("");
const busy = ref(false);
const restoreError = ref<string | null>(null);
const restored = ref<RestoreResult | null>(null);
const path = computed(() => `/api/groups/${encodeURIComponent(props.groupId)}`);
const metrics = computed(() => readMetrics(detail.value?.match));

async function load(): Promise<void> {
  try {
    detail.value = await apiGet<GroupDetail>(path.value);
    error.value = null;
  } catch (e) {
    error.value = errorText(e);
  }
}

function openRestore(): void {
  reason.value = "";
  restoreError.value = null;
  restoreOpen.value = true;
}

async function restore(): Promise<void> {
  busy.value = true;
  restoreError.value = null;
  try {
    restored.value = await apiPost<RestoreResult>(`${path.value}/restore`, {
      reason: reason.value.trim(),
    });
    restoreOpen.value = false;
    await load();
  } catch (e) {
    restoreError.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div data-testid="group-detail">
    <Message v-if="error" severity="error" data-testid="group-error">{{ error }}</Message>
    <p v-else-if="detail === null">Loading...</p>
    <template v-else>
      <h2>
        Group {{ detail.group.id }}
        <Tag :value="detail.group.status" :severity="severityOf(detail.group.status)" />
      </h2>
      <dl class="summary">
        <dt>Start</dt>
        <dd>{{ fmtTime(detail.group.startMs) }}</dd>
        <dt>Name</dt>
        <dd>{{ detail.group.name ?? "-" }}</dd>
        <dt>Path</dt>
        <dd>{{ detail.group.path ?? "-" }}</dd>
        <dt>Match</dt>
        <dd>{{ metrics.decision }}, overlap {{ metrics.overlap }}, median {{ metrics.median }}</dd>
        <dt>Merged activity</dt>
        <dd>{{ detail.group.mergedActivityId ?? "-" }}</dd>
        <dt>Parked</dt>
        <dd>{{ detail.group.parkedReason ?? "-" }}</dd>
        <dt>Last error</dt>
        <dd>{{ detail.group.lastError ?? "-" }}</dd>
        <dt>Trial</dt>
        <dd>{{ detail.group.trial ? "yes" : "no" }}</dd>
      </dl>

      <div v-if="detail.restorable" class="restore">
        <Button
          label="Restore originals"
          severity="warn"
          data-testid="restore-button"
          @click="openRestore"
        />
      </div>
      <Message v-if="restored" severity="success" data-testid="restore-result">
        Restore finished: status {{ restored.status }}.
        <span v-for="r in restored.restored" :key="r.id">
          {{ r.id }} {{ r.outcome }}{{ r.newId === null ? "" : ` as ${r.newId}` }}.
        </span>
        Un-hidden: {{ restored.unhidden.length }}. Flags: {{ restored.flags.join(", ") || "none" }}.
      </Message>

      <h3>Members</h3>
      <DataTable :value="detail.members" data-key="id" size="small" data-testid="members-table">
        <Column field="id" header="Activity" />
        <Column field="source" header="Source" />
        <Column field="deviceName" header="Device" />
        <Column field="originalStatus" header="Original" />
        <Column header="Gone">
          <template #body="{ data }">{{ fmtTime(data.goneAt) }}</template>
        </Column>
        <Column field="restoredAs" header="Restored as" />
      </DataTable>

      <h3>Events</h3>
      <Timeline :value="detail.events" data-testid="event-timeline">
        <template #content="{ item }">
          <div data-testid="event-item" class="event">
            <span>{{ fmtTime(item.at) }}</span>
            <span>{{ item.from ?? "-" }} -&gt; {{ item.to ?? "-" }}</span>
            <strong>{{ item.event }}</strong>
            <details>
              <summary>evidence</summary>
              <pre>{{ prettyJson(item.evidence) }}</pre>
            </details>
          </div>
        </template>
      </Timeline>

      <h3>Strava writes</h3>
      <DataTable :value="detail.writes" data-key="id" size="small" data-testid="writes-table">
        <Column field="id" header="#" />
        <Column field="kind" header="Kind" />
        <Column field="targetId" header="Target" />
        <Column field="status" header="Status" />
        <Column header="Created">
          <template #body="{ data }">{{ fmtTime(data.createdAt) }}</template>
        </Column>
        <Column header="Completed">
          <template #body="{ data }">{{ fmtTime(data.completedAt) }}</template>
        </Column>
      </DataTable>
    </template>

    <Dialog
      v-model:visible="restoreOpen"
      modal
      header="Restore originals"
      :style="{ width: '32rem' }"
    >
      <p>
        Re-uploads deleted originals from their backed-up files and un-hides hidden ones. The merged
        activity stays on Strava.
      </p>
      <Textarea
        v-model="reason"
        rows="3"
        class="full"
        placeholder="Why restore"
        data-testid="restore-reason"
      />
      <Message v-if="restoreError" severity="error" data-testid="restore-error">
        {{ restoreError }}
      </Message>
      <template #footer>
        <Button label="Cancel" text data-testid="restore-cancel" @click="restoreOpen = false" />
        <Button
          label="Restore"
          severity="warn"
          :disabled="busy || reason.trim() === ''"
          data-testid="restore-confirm"
          @click="restore"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.summary {
  display: grid;
  grid-template-columns: 10rem 1fr;
  gap: 0.25rem 1rem;
}
.summary dd {
  margin: 0;
}
.event {
  display: grid;
  gap: 0.15rem;
  padding-bottom: 0.75rem;
}
pre {
  font-size: 0.8rem;
  white-space: pre-wrap;
  max-height: 20rem;
  overflow: auto;
}
.full {
  width: 100%;
}
</style>
