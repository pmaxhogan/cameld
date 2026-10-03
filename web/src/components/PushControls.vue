<script setup lang="ts">
import Button from "primevue/button";
import { onMounted, ref } from "vue";
import { errorText } from "../api.ts";
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushSupported,
  sendTestPush,
} from "../push.ts";

const props = defineProps<{ publicKey: string }>();

const supported = pushSupported();
const enabled = ref(false);
const busy = ref(false);
const note = ref<string | null>(null);

async function run(action: () => Promise<string | null>): Promise<void> {
  busy.value = true;
  note.value = null;
  try {
    note.value = await action();
  } catch (error) {
    note.value = `Push failed: ${errorText(error)}`;
  } finally {
    busy.value = false;
  }
}

onMounted(() =>
  run(async () => {
    enabled.value = supported && (await currentSubscription()) !== null;
    return null;
  }),
);

function toggle(): Promise<void> {
  return run(async () => {
    if (enabled.value) {
      await disablePush();
      enabled.value = false;
      return "Push off for this browser";
    }
    await enablePush(props.publicKey);
    enabled.value = true;
    return "Push on for this browser";
  });
}

function test(): Promise<void> {
  return run(async () => {
    const summary = await sendTestPush();
    return `Test sent to ${summary.sent} of ${summary.total} browsers`;
  });
}
</script>

<template>
  <div class="push">
    <template v-if="supported">
      <Button
        :label="enabled ? 'Disable push' : 'Enable push'"
        size="small"
        outlined
        :disabled="busy"
        data-testid="push-enable"
        @click="toggle"
      />
      <Button
        v-if="enabled"
        label="Send test"
        size="small"
        text
        :disabled="busy"
        data-testid="push-test"
        @click="test"
      />
    </template>
    <span v-else class="muted" data-testid="push-unsupported">
      Push needs HTTPS and a modern browser
    </span>
    <span v-if="note" class="muted" data-testid="push-note">{{ note }}</span>
  </div>
</template>

<style scoped>
.push {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.muted {
  font-size: 0.85rem;
  opacity: 0.8;
}
</style>
