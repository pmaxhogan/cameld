<script setup lang="ts">
import type { ApiSettings, SettingsUpdate } from "@cameld/shared";
import Button from "primevue/button";
import Message from "primevue/message";
import ToggleSwitch from "primevue/toggleswitch";
import { onMounted, ref } from "vue";
import { apiGet, apiPatch, errorText } from "../api.ts";
import PhraseConfirmDialog from "../components/PhraseConfirmDialog.vue";
import {
  FIELDS,
  SWITCHES,
  buildPatch,
  fieldValues,
  readPath,
  setPath,
  switchValues,
  type SwitchDef,
  type Toggles,
  type Values,
} from "../settings-form.ts";

const settings = ref<ApiSettings | null>(null);
const values = ref<Values>({});
const toggles = ref<Toggles>({});
const saved = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const pending = ref<SwitchDef | null>(null);
const phraseError = ref<string | null>(null);

function adopt(next: ApiSettings): void {
  settings.value = next;
  values.value = fieldValues(next);
  toggles.value = switchValues(next);
}

async function send(update: SettingsUpdate, done: string): Promise<void> {
  busy.value = true;
  saved.value = null;
  error.value = null;
  try {
    const next = await apiPatch<ApiSettings>("/api/settings", update);
    // Keep unsaved edits in the form; the next save diffs against `next`.
    const keepValues = values.value;
    const keepToggles = toggles.value;
    adopt(next);
    values.value = { ...keepValues };
    toggles.value = { ...keepToggles };
    saved.value = done;
  } finally {
    busy.value = false;
  }
}

function onToggle(sw: SwitchDef, on: boolean): void {
  toggles.value[sw.id] = on;
  if (sw.dangerous && on && readPath(settings.value, sw.path) !== true) {
    phraseError.value = null;
    pending.value = sw;
  }
}

function cancelDangerous(): void {
  toggles.value[(pending.value as SwitchDef).id] = false;
  pending.value = null;
}

async function confirmDangerous(phrase: string): Promise<void> {
  const sw = pending.value as SwitchDef;
  const patch: Record<string, unknown> = {};
  setPath(patch, sw.path, true);
  try {
    await send({ patch, confirm: phrase }, `${sw.label}: on`);
    pending.value = null;
  } catch (e) {
    phraseError.value = errorText(e);
  }
}

async function save(): Promise<void> {
  const result = buildPatch(settings.value as ApiSettings, values.value, toggles.value);
  if (result.invalid.length > 0) {
    saved.value = null;
    error.value = `Not a number: ${result.invalid.join(", ")}`;
    return;
  }
  if (result.changed === 0) {
    error.value = null;
    saved.value = "Nothing changed";
    return;
  }
  try {
    await send({ patch: result.patch }, "Settings saved");
    adopt(settings.value as ApiSettings);
  } catch (e) {
    error.value = errorText(e);
  }
}

onMounted(async () => {
  try {
    adopt(await apiGet<ApiSettings>("/api/settings"));
  } catch (e) {
    error.value = errorText(e);
  }
});
</script>

<template>
  <section class="settings">
    <h2>Settings</h2>
    <Message v-if="error" severity="error" data-testid="settings-error">{{ error }}</Message>
    <Message v-if="saved" severity="success" data-testid="settings-saved">{{ saved }}</Message>
    <p v-if="settings === null && !error">Loading...</p>
    <template v-if="settings">
      <h3>Switches</h3>
      <div v-for="sw in SWITCHES" :key="sw.id" class="switch">
        <ToggleSwitch
          :model-value="toggles[sw.id]"
          :input-id="`switch-${sw.id}`"
          :pt="{ input: { 'data-testid': sw.testid } }"
          @update:model-value="onToggle(sw, $event)"
        />
        <label :for="`switch-${sw.id}`">{{ sw.label }}</label>
      </div>
      <p class="muted">
        Deletion trial: {{ settings.trial.enabled ? "on" : "off" }}, up to
        {{ settings.trial.maxPairs }} pairs.
      </p>

      <h3>Timing and thresholds</h3>
      <div class="fields">
        <label v-for="field in FIELDS" :key="field.id">
          <span>{{ field.label }}</span>
          <input
            v-model="values[field.id]"
            type="number"
            step="any"
            class="p-inputtext"
            :data-testid="field.testid"
          />
        </label>
      </div>
      <Button label="Save" :disabled="busy" data-testid="settings-save" @click="save" />
    </template>

    <PhraseConfirmDialog
      :visible="pending !== null"
      title="Turn on deletion of originals"
      :busy="busy"
      :error="phraseError"
      @confirm="confirmDangerous"
      @cancel="cancelDangerous"
    >
      <p>
        After a merged activity is uploaded and checked, cameld waits for the grace period and then
        deletes the original recordings from Strava.
      </p>
    </PhraseConfirmDialog>
  </section>
</template>

<style scoped>
.switch {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  margin-bottom: 0.5rem;
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 0.75rem 1.5rem;
  margin-bottom: 1rem;
}
.fields label {
  display: grid;
  gap: 0.25rem;
}
.muted {
  opacity: 0.75;
  font-size: 0.85rem;
}
</style>
