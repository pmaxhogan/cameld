<script setup lang="ts">
import type { GroupSummary } from "@cameld/shared";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, onMounted, ref, watch } from "vue";
import { apiGet, errorText } from "../api.ts";
import { fmtTime, severityOf } from "../format.ts";
import { groupHref } from "../router.ts";
import GroupDetailView from "./GroupDetailView.vue";

const props = defineProps<{ counts: Record<string, number>; groupId: string | null }>();

const filter = ref("");
const groups = ref<GroupSummary[] | null>(null);
const error = ref<string | null>(null);
const statuses = computed(() => Object.keys(props.counts).sort());

function query(): string {
  const params = new URLSearchParams({ limit: "200" });
  if (filter.value !== "") params.set("status", filter.value);
  return `/api/groups?${params.toString()}`;
}

async function load(): Promise<void> {
  try {
    groups.value = await apiGet<GroupSummary[]>(query());
    error.value = null;
  } catch (e) {
    error.value = errorText(e);
  }
}

watch(filter, load);
onMounted(load);
</script>

<template>
  <section>
    <template v-if="groupId">
      <a href="#/history" data-testid="history-back">Back to history</a>
      <GroupDetailView :key="groupId" :group-id="groupId" />
    </template>
    <template v-else>
      <h2>History</h2>
      <label class="filter">
        Status
        <select v-model="filter" class="p-inputtext" data-testid="history-filter">
          <option value="">all</option>
          <option v-for="s in statuses" :key="s" :value="s">{{ s }} ({{ counts[s] }})</option>
        </select>
      </label>
      <Message v-if="error" severity="error" data-testid="history-error">{{ error }}</Message>
      <DataTable :value="groups ?? []" data-key="id" size="small" data-testid="history-table">
        <template #empty><span data-testid="history-empty">No groups.</span></template>
        <Column header="Start">
          <template #body="{ data }">
            <a :href="groupHref(data.id)" data-testid="history-row">{{ fmtTime(data.startMs) }}</a>
          </template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <Tag :value="data.status" :severity="severityOf(data.status)" />
          </template>
        </Column>
        <Column field="name" header="Name" />
        <Column field="sportType" header="Sport" />
        <Column header="Members">
          <template #body="{ data }">
            {{ data.appIds.length }} app, {{ data.fitbitIds.length }} fitbit
          </template>
        </Column>
        <Column header="Updated">
          <template #body="{ data }">{{ fmtTime(data.updatedAt) }}</template>
        </Column>
      </DataTable>
    </template>
  </section>
</template>

<style scoped>
.filter {
  display: inline-flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.75rem;
}
</style>
