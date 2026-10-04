<script setup lang="ts">
import { DELETE_CONFIRM_PHRASE } from "@cameld/shared";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import { computed, ref, watch } from "vue";

/**
 * The strong confirmation in front of anything that deletes Strava originals:
 * the owner must type DELETE_CONFIRM_PHRASE exactly. Only the buttons close it.
 */
const props = defineProps<{
  visible: boolean;
  title: string;
  busy: boolean;
  error: string | null;
}>();
const emit = defineEmits<{ confirm: [phrase: string]; cancel: [] }>();

const typed = ref("");
const matches = computed(() => typed.value === DELETE_CONFIRM_PHRASE);

watch(
  () => props.visible,
  () => {
    typed.value = "";
  },
);
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :closable="false"
    :close-on-escape="false"
    :header="title"
    :style="{ width: '34rem', maxWidth: '95vw' }"
    :pt="{ root: { 'data-testid': 'delete-confirm-dialog' } }"
  >
    <Message severity="warn" :closable="false">
      Original activities will be PERMANENTLY DELETED from Strava after the grace period. Their
      backups are kept on the NAS and Restore can re-upload them, but Strava kudos, comments and
      segment history on the originals are lost.
    </Message>
    <slot />
    <p>
      Type <code>{{ DELETE_CONFIRM_PHRASE }}</code> to confirm.
    </p>
    <InputText
      v-model="typed"
      class="full"
      autocomplete="off"
      :placeholder="DELETE_CONFIRM_PHRASE"
      data-testid="delete-confirm-input"
    />
    <Message v-if="error" severity="error" data-testid="delete-confirm-error">{{ error }}</Message>
    <template #footer>
      <Button label="Cancel" text data-testid="delete-confirm-cancel" @click="emit('cancel')" />
      <Button
        label="Turn on deletion"
        severity="danger"
        :disabled="!matches || busy"
        data-testid="delete-confirm-submit"
        @click="emit('confirm', typed)"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.full {
  width: 100%;
}
</style>
