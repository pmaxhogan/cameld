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
import TrackComparison from "../components/TrackComparison.vue";
import { fmtTime, prettyJson, readMetrics, severityOf } from "../format.ts";
import {
  eventLabel,
  evidenceEntries,
  groupTitle,
  lastErrorLabel,
  parkLabel,
  sourceLabel,
  statusLabel,
  stravaActivityUrl,
  writeKindLabel,
} from "../labels.ts";

const props = defineProps<{ groupId: string; styleUrl: string | null }>();

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
  <div class="group-detail" data-testid="group-detail">
    <Message v-if="error" severity="error" data-testid="group-error">{{ error }}</Message>
    <p v-else-if="detail === null">Loading...</p>
    <template v-else>
      <h2 class="title">
        <span data-testid="group-title">{{ groupTitle(detail.group) }}</span>
        <Tag
          :value="statusLabel(detail.group.status)"
          :severity="severityOf(detail.group.status)"
        />
      </h2>
      <p class="secondary">
        Group <code data-testid="group-id">{{ detail.group.id }}</code>
      </p>
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
        <dd data-testid="merged-activity">
          <a
            v-if="detail.group.mergedActivityId !== null"
            :href="stravaActivityUrl(detail.group.mergedActivityId)"
            target="_blank"
            rel="noopener noreferrer"
            >{{ detail.group.mergedActivityId }} on Strava</a
          >
          <template v-else>-</template>
        </dd>
        <dt>Parked</dt>
        <dd data-testid="parked-reason">
          {{ parkLabel(detail.group.parkedReason) }}
          <code v-if="detail.group.parkedReason" class="code">{{ detail.group.parkedReason }}</code>
        </dd>
        <dt>Last note</dt>
        <dd data-testid="last-error">
          {{ lastErrorLabel(detail.group.lastError) }}
          <code v-if="detail.group.lastError" class="code">{{ detail.group.lastError }}</code>
        </dd>
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

      <template v-if="detail.mergeBuilt">
        <h3>Tracks</h3>
        <TrackComparison :group-id="detail.group.id" :style-url="styleUrl" />
      </template>

      <h3>Members</h3>
      <div class="table-scroll">
        <DataTable :value="detail.members" data-key="id" size="small" data-testid="members-table">
          <Column header="Activity">
            <template #body="{ data }">
              <a
                :href="stravaActivityUrl(data.id)"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="member-link"
                >{{ data.id }}</a
              >
            </template>
          </Column>
          <Column header="Source">
            <template #body="{ data }">{{ sourceLabel(data.source) }}</template>
          </Column>
          <Column header="Device">
            <template #body="{ data }">{{ data.deviceName ?? "-" }}</template>
          </Column>
          <Column field="originalStatus" header="Original file" />
          <Column header="Gone">
            <template #body="{ data }">{{ fmtTime(data.goneAt) }}</template>
          </Column>
          <Column header="Restored as">
            <template #body="{ data }">
              <a
                v-if="data.restoredAs !== null"
                :href="stravaActivityUrl(data.restoredAs)"
                target="_blank"
                rel="noopener noreferrer"
                >{{ data.restoredAs }}</a
              >
              <template v-else>-</template>
            </template>
          </Column>
        </DataTable>
      </div>

      <h3>Events</h3>
      <Timeline :value="detail.events" data-testid="event-timeline">
        <template #content="{ item }">
          <div data-testid="event-item" class="event">
            <span class="muted">{{ fmtTime(item.at) }}</span>
            <strong data-testid="event-label">{{ eventLabel(item.event) }}</strong>
            <span class="muted">
              {{ statusLabel(item.from) }} -&gt; {{ statusLabel(item.to) }}
              <code class="code">{{ item.event }}</code>
            </span>
            <dl
              v-if="evidenceEntries(item.evidence).length > 0"
              class="evidence"
              data-testid="event-evidence"
            >
              <template v-for="entry in evidenceEntries(item.evidence)" :key="entry.key">
                <dt>{{ entry.key }}</dt>
                <dd>{{ entry.value }}</dd>
              </template>
            </dl>
            <details>
              <summary>Raw JSON</summary>
              <pre>{{ prettyJson(item.evidence) }}</pre>
            </details>
          </div>
        </template>
      </Timeline>

      <h3>Strava writes</h3>
      <div class="table-scroll">
        <DataTable :value="detail.writes" data-key="id" size="small" data-testid="writes-table">
          <template #empty><span>No Strava writes yet.</span></template>
          <Column field="id" header="#" />
          <Column header="Kind">
            <template #body="{ data }">{{ writeKindLabel(data.kind) }}</template>
          </Column>
          <Column header="Target">
            <template #body="{ data }">
              <a
                v-if="data.targetId !== null"
                :href="stravaActivityUrl(data.targetId)"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="write-target"
                >{{ data.targetId }}</a
              >
              <code v-else-if="data.externalId" data-testid="write-target">{{
                data.externalId
              }}</code>
              <template v-else>-</template>
            </template>
          </Column>
          <Column field="status" header="Status" />
          <Column header="Time">
            <template #body="{ data }">
              <span data-testid="write-time">{{
                data.completedAt === null
                  ? `${fmtTime(data.createdAt)} (requested)`
                  : fmtTime(data.completedAt)
              }}</span>
            </template>
          </Column>
        </DataTable>
      </div>
    </template>

    <Dialog
      v-model:visible="restoreOpen"
      modal
      header="Restore originals"
      :style="{ width: '32rem', maxWidth: '95vw' }"
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
.group-detail {
  min-width: 0;
}
.title {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.25rem;
}
.secondary {
  margin-top: 0;
  opacity: 0.7;
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.summary {
  display: grid;
  grid-template-columns: minmax(7rem, 10rem) minmax(0, 1fr);
  gap: 0.25rem 1rem;
}
.summary dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.code {
  font-size: 0.75rem;
  opacity: 0.7;
  margin-left: 0.35rem;
}
.muted {
  opacity: 0.75;
  font-size: 0.85rem;
}
.event {
  display: grid;
  gap: 0.15rem;
  padding-bottom: 0.75rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.evidence {
  display: grid;
  grid-template-columns: minmax(6rem, max-content) minmax(0, 1fr);
  gap: 0.1rem 0.75rem;
  margin: 0.25rem 0;
  font-size: 0.85rem;
}
.evidence dt {
  opacity: 0.75;
}
.evidence dd {
  margin: 0;
}
:deep(.p-timeline-event-opposite) {
  flex: 0;
  padding: 0;
}
.table-scroll {
  max-width: 100%;
  overflow-x: auto;
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
