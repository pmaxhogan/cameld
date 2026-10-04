<script setup lang="ts">
import {
  BACKFILL_MODES,
  type ApiStatus,
  type BackfillControl,
  type BackfillInfo,
  type BackfillMode,
  type BackfillUpdate,
} from "@cameld/shared";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import ProgressBar from "primevue/progressbar";
import Tag from "primevue/tag";
import { computed, onMounted, ref } from "vue";
import { apiGet, apiPatch, apiPost, errorText, isFailure } from "../api.ts";
import PhraseConfirmDialog from "../components/PhraseConfirmDialog.vue";
import { fmtTime, usagePct } from "../format.ts";
import { BUDGET_WINDOW_LABELS, stoppedLabel } from "../labels.ts";
import DryRunTable from "./DryRunTable.vue";

const props = defineProps<{ status: ApiStatus }>();

/** Typed back before the cursor is reset. */
const RESET_PHRASE = "reset";

const info = ref<BackfillInfo>(props.status.backfill);
const mode = ref<BackfillMode>(info.value.mode);
const dailyReads = ref<number | string>(info.value.budget.dailyReads);
const fifteenMinuteReads = ref<number | string>(info.value.budget.fifteenMinuteReads);
const notice = ref<{ ok: boolean; text: string } | null>(null);
const busy = ref(false);
const resetOpen = ref(false);
const resetTyped = ref("");
const phraseOpen = ref(false);
const phraseError = ref<string | null>(null);

/** Strava's own counters: the whole Strava app, shared with other consumers. */
const rateRows = computed(() => {
  const rate = props.status.rate;
  if (rate === null) return null;
  return [
    { label: "Overall, 15 min", window: rate.overall.fifteenMinute },
    { label: "Overall, day", window: rate.overall.day },
    { label: "Read, 15 min", window: rate.read.fifteenMinute },
    { label: "Read, day", window: rate.read.day },
  ];
});

/** cameld's own backfill caps (settings), spent only by the backfill. */
const budgetRows = computed(() => {
  const b = info.value.budget;
  return [
    {
      id: "fifteen",
      label: "15 min",
      window: { usage: b.fifteenMinuteUsed, limit: b.fifteenMinuteReads },
      left: Math.max(0, b.fifteenMinuteReads - b.fifteenMinuteUsed),
    },
    {
      id: "daily",
      label: "Today",
      window: { usage: b.dailyUsed, limit: b.dailyReads },
      left: Math.max(0, b.dailyReads - b.dailyUsed),
    },
  ];
});

function adopt(next: BackfillInfo): void {
  info.value = next;
  mode.value = next.mode;
  dailyReads.value = next.budget.dailyReads;
  fifteenMinuteReads.value = next.budget.fifteenMinuteReads;
}

async function act(work: () => Promise<BackfillInfo>, done: string): Promise<void> {
  busy.value = true;
  try {
    adopt(await work());
    notice.value = { ok: true, text: done };
  } catch (e) {
    notice.value = { ok: false, text: errorText(e) };
    throw e;
  } finally {
    busy.value = false;
  }
}

function update(confirm?: string): BackfillUpdate {
  return {
    mode: mode.value,
    dailyReads: Number(dailyReads.value),
    fifteenMinuteReads: Number(fifteenMinuteReads.value),
    ...(confirm === undefined ? {} : { confirm }),
  };
}

async function save(): Promise<void> {
  try {
    await act(() => apiPatch<BackfillInfo>("/api/backfill", update()), "Backfill settings saved");
  } catch (e) {
    if (isFailure(e, "confirm_required")) {
      phraseError.value = null;
      phraseOpen.value = true;
    }
  }
}

async function saveConfirmed(phrase: string): Promise<void> {
  try {
    await act(
      () => apiPatch<BackfillInfo>("/api/backfill", update(phrase)),
      "Backfill settings saved",
    );
    phraseOpen.value = false;
  } catch (e) {
    phraseError.value = errorText(e);
  }
}

function openReset(): void {
  resetTyped.value = "";
  resetOpen.value = true;
}

async function control(action: BackfillControl["action"]): Promise<void> {
  await act(
    () => apiPost<BackfillInfo>("/api/backfill/control", { action }),
    `Backfill ${action} sent`,
  ).catch(() => undefined);
  resetOpen.value = false;
}

onMounted(async () => {
  try {
    adopt(await apiGet<BackfillInfo>("/api/backfill"));
  } catch (e) {
    notice.value = { ok: false, text: errorText(e) };
  }
});
</script>

<template>
  <section class="backfill">
    <h2>Backfill</h2>
    <Message
      v-if="notice"
      :severity="notice.ok ? 'success' : 'error'"
      data-testid="backfill-message"
    >
      {{ notice.text }}
    </Message>

    <div class="cards">
      <div class="card" data-testid="rate-budget">
        <h3>Strava app usage (all consumers)</h3>
        <p class="note">
          Strava's own counters for the whole Strava app, which other consumers share. Used / limit.
        </p>
        <p v-if="rateRows === null">No Strava data yet</p>
        <template v-else>
          <div v-for="row in rateRows" :key="row.label" class="rate">
            <span>{{ row.label }}</span>
            <ProgressBar :value="usagePct(row.window)" :show-value="false" />
            <span>{{ row.window.usage }} / {{ row.window.limit }}</span>
          </div>
        </template>
      </div>

      <div class="card" data-testid="cameld-budget">
        <h3>cameld budget (backfill only)</h3>
        <p class="note">
          cameld's own caps on backfill reads, set below. Used / cap, and what is left.
        </p>
        <div
          v-for="row in budgetRows"
          :key="row.id"
          class="rate"
          :data-testid="`cameld-budget-${row.id}`"
        >
          <span>{{ row.label }}</span>
          <ProgressBar :value="usagePct(row.window)" :show-value="false" />
          <span>{{ row.window.usage }} / {{ row.window.limit }}, {{ row.left }} left</span>
        </div>
        <dl>
          <dt>Reads today</dt>
          <dd data-testid="reads-today">
            {{ info.budget.dailyUsed }} of {{ info.budget.dailyReads }} (cameld daily cap)
          </dd>
          <dt>Budget left</dt>
          <dd data-testid="budget-left">
            {{ info.budget.remaining }} reads now (limited by the
            {{ BUDGET_WINDOW_LABELS[info.budget.limitedBy] }})
          </dd>
        </dl>
      </div>

      <div class="card" data-testid="login-health">
        <h3>Strava web login</h3>
        <Tag
          :value="status.web.healthy ? 'healthy' : 'unhealthy'"
          :severity="status.web.healthy ? 'success' : 'danger'"
        />
        <p v-if="status.web.reason">{{ status.web.reason }}</p>
        <a href="#/browser">Open the Strava login browser</a>
      </div>

      <div class="card" data-testid="backfill-progress">
        <h3>Progress</h3>
        <dl>
          <dt>Activities</dt>
          <dd>{{ info.progress.activities }}</dd>
          <dt>Cursor</dt>
          <dd>{{ fmtTime(info.progress.cursorMs) }}</dd>
          <dt>Done</dt>
          <dd>{{ info.progress.done ? "yes" : "no" }}</dd>
          <dt>Running</dt>
          <dd>{{ info.running ? "yes" : "no" }}{{ info.paused ? " (paused)" : "" }}</dd>
        </dl>
        <p v-if="info.lastBatch" data-testid="backfill-last-batch">
          Last batch ({{ info.lastBatch.mode }}): {{ info.lastBatch.activities }} activities,
          {{ info.lastBatch.groups }} groups, stopped: {{ stoppedLabel(info.lastBatch)
          }}{{ info.lastBatch.error ? `, error: ${info.lastBatch.error}` : "" }}
        </p>
      </div>
    </div>

    <div class="form">
      <label>
        Mode
        <select v-model="mode" class="p-inputtext" data-testid="backfill-mode">
          <option v-for="m in BACKFILL_MODES" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <label>
        cameld reads per day
        <input
          v-model="dailyReads"
          type="number"
          min="0"
          class="p-inputtext"
          data-testid="backfill-daily"
        />
      </label>
      <label>
        cameld reads per 15 min
        <input
          v-model="fifteenMinuteReads"
          type="number"
          min="0"
          class="p-inputtext"
          data-testid="backfill-fifteen"
        />
      </label>
      <Button label="Save" :disabled="busy" data-testid="backfill-save" @click="save" />
    </div>

    <div class="controls">
      <Button
        label="Start"
        :disabled="busy || !info.available || info.running"
        data-testid="backfill-start"
        @click="control('start')"
      />
      <Button
        :label="info.paused ? 'Resume' : 'Pause'"
        severity="secondary"
        :disabled="busy"
        data-testid="backfill-pause"
        @click="control(info.paused ? 'resume' : 'pause')"
      />
    </div>

    <DryRunTable :mode="info.mode" />

    <div class="danger" data-testid="backfill-danger">
      <h3>Danger zone</h3>
      <p class="note">
        Resetting the cursor makes the backfill walk the whole history again from the newest
        activity. Backups already taken are kept, but every activity costs reads again.
      </p>
      <Button
        label="Reset cursor..."
        severity="danger"
        outlined
        size="small"
        :disabled="busy"
        data-testid="backfill-reset"
        @click="openReset"
      />
    </div>

    <Dialog
      v-model:visible="resetOpen"
      modal
      header="Reset backfill cursor"
      :style="{ width: '30rem', maxWidth: '95vw' }"
    >
      <p>The backfill starts again from the newest activity. Backups already taken are kept.</p>
      <p>
        Type <code>{{ RESET_PHRASE }}</code> to confirm.
      </p>
      <InputText
        v-model="resetTyped"
        class="full"
        autocomplete="off"
        :placeholder="RESET_PHRASE"
        data-testid="backfill-reset-input"
      />
      <template #footer>
        <Button
          label="Cancel"
          text
          data-testid="backfill-reset-cancel"
          @click="resetOpen = false"
        />
        <Button
          label="Reset cursor"
          severity="danger"
          :disabled="busy || resetTyped.trim() !== RESET_PHRASE"
          data-testid="backfill-reset-confirm"
          @click="control('reset')"
        />
      </template>
    </Dialog>

    <PhraseConfirmDialog
      :visible="phraseOpen"
      title="Confirm live backfill"
      :busy="busy"
      :error="phraseError"
      @confirm="saveConfirmed"
      @cancel="phraseOpen = false"
    >
      <p>Live mode merges past activities and, with deletion on, deletes their originals.</p>
    </PhraseConfirmDialog>
  </section>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr));
  gap: 1rem;
}
.card {
  border: 1px solid #d1d5db;
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  min-width: 0;
}
.card h3 {
  margin: 0 0 0.25rem;
}
.note {
  margin: 0 0 0.75rem;
  font-size: 0.8rem;
  opacity: 0.75;
}
.rate {
  display: grid;
  grid-template-columns: 6.5rem minmax(3rem, 1fr) auto;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.35rem;
  font-size: 0.9rem;
}
dl {
  display: grid;
  grid-template-columns: 7rem minmax(0, 1fr);
  gap: 0.15rem 0.75rem;
}
dd {
  margin: 0;
}
.form,
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: end;
  margin: 1rem 0;
}
.form label {
  display: grid;
  gap: 0.25rem;
}
.danger {
  margin-top: 2rem;
  padding: 0.75rem 1rem;
  border: 1px solid #fca5a5;
  border-radius: 0.5rem;
}
.danger h3 {
  margin: 0 0 0.25rem;
}
.full {
  width: 100%;
}
</style>
