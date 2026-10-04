<script setup lang="ts">
import type { BackfillMode, BackfillReport } from "@cameld/shared";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, onMounted, ref } from "vue";
import { apiGet, errorText } from "../api.ts";
import { dryRunRow, fmtTime, severityOf } from "../format.ts";

defineProps<{ mode: BackfillMode }>();

const report = ref<BackfillReport | null>(null);
const error = ref<string | null>(null);
const rows = computed(() => (report.value?.groups ?? []).map(dryRunRow));

async function load(): Promise<void> {
  try {
    report.value = await apiGet<BackfillReport>("/api/backfill/report");
    error.value = null;
  } catch (e) {
    error.value = errorText(e);
  }
}

onMounted(load);
</script>

<template>
  <div class="dry-run">
    <h3>
      Dry-run report
      <Button label="Refresh" size="small" text data-testid="dry-run-refresh" @click="load" />
    </h3>
    <Message v-if="error" severity="error" data-testid="dry-run-error">{{ error }}</Message>
    <p v-if="report" class="muted">Generated {{ fmtTime(report.generatedAt) }}</p>
    <div class="table-scroll">
      <DataTable :value="rows" data-key="key" size="small" data-testid="dry-run-table">
        <template #empty>
          <span data-testid="dry-run-empty">
            No dry-run results yet. This report fills only while the backfill runs in
            <code>dry_run</code> mode (it scores and builds every pair it finds without writing to
            Strava).
            <template v-if="mode !== 'dry_run'">
              The current mode is <code>{{ mode }}</code
              >: choose dry_run, Save, then Start.
            </template>
          </span>
        </template>
        <Column field="start" header="Start" />
        <Column header="Decision">
          <template #body="{ data }">
            <Tag :value="data.decision" :severity="severityOf(data.decision)" />
          </template>
        </Column>
        <Column field="members" header="Members" />
        <Column field="overlap" header="Overlap" />
        <Column field="median" header="Median distance" />
        <Column field="noLoss" header="No-loss check" />
      </DataTable>
    </div>
  </div>
</template>

<style scoped>
.table-scroll {
  max-width: 100%;
  overflow-x: auto;
}
.muted {
  opacity: 0.75;
  font-size: 0.85rem;
}
</style>
