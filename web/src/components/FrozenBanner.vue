<script setup lang="ts">
import type { FreezeInfo } from "@cameld/shared";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import Message from "primevue/message";
import Textarea from "primevue/textarea";
import { computed, ref } from "vue";
import { apiPost, errorText } from "../api.ts";
import { fmtTime } from "../format.ts";

defineProps<{ freeze: FreezeInfo }>();

const open = ref(false);
const reason = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const canSubmit = computed(() => reason.value.trim() !== "" && !busy.value);

function show(): void {
  reason.value = "";
  error.value = null;
  open.value = true;
}

async function submit(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await apiPost<FreezeInfo>("/api/freeze/unfreeze", { reason: reason.value.trim() });
    open.value = false;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="frozen" data-testid="frozen-banner" role="alert">
    <div>
      <strong>FROZEN.</strong> All Strava writes are stopped.
      <span data-testid="frozen-reason">{{ freeze.reason }}</span>
      <span class="when">since {{ fmtTime(freeze.frozenAt) }}</span>
    </div>
    <Button
      label="Unfreeze"
      severity="contrast"
      size="small"
      data-testid="unfreeze-button"
      @click="show"
    />
    <Dialog v-model:visible="open" modal header="Unfreeze cameld" :style="{ width: '32rem' }">
      <p>
        Writes resume after this. Only unfreeze once you understand why it froze. The reason is
        recorded in the audit log.
      </p>
      <Textarea
        v-model="reason"
        rows="3"
        class="full"
        placeholder="Why it is safe to resume"
        data-testid="unfreeze-reason"
      />
      <Message v-if="error" severity="error" data-testid="unfreeze-error">{{ error }}</Message>
      <template #footer>
        <Button label="Cancel" text data-testid="unfreeze-cancel" @click="open = false" />
        <Button
          label="Unfreeze"
          severity="danger"
          :disabled="!canSubmit"
          data-testid="unfreeze-confirm"
          @click="submit"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.frozen {
  display: flex;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: #b91c1c;
  color: #fff;
}
.when {
  opacity: 0.85;
  margin-left: 0.5rem;
}
.full {
  width: 100%;
}
</style>
