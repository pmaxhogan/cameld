<script setup lang="ts">
import type { ApiStatus } from "@cameld/shared";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { ref } from "vue";
import { apiPost, errorText } from "../api.ts";

defineProps<{ status: ApiStatus }>();

/** The server proxies the KasmVNC web client here and injects its credentials. */
const BROWSER_SRC = "/browser/?autoconnect=1&resize=remote&reconnect=1&path=browser/websockify";

const src = ref(BROWSER_SRC);
const checking = ref(false);
const error = ref<string | null>(null);

async function check(): Promise<void> {
  checking.value = true;
  error.value = null;
  try {
    // The write refreshes /api/status, which carries the new login health.
    await apiPost<ApiStatus["web"]>("/api/web/check");
  } catch (e) {
    error.value = errorText(e);
  } finally {
    checking.value = false;
  }
}

function reload(): void {
  src.value = `${BROWSER_SRC}&r=${Date.now()}`;
}
</script>

<template>
  <section class="browser">
    <Message v-if="!status.browserAvailable" severity="warn" data-testid="browser-unavailable">
      The Strava login browser is not configured. Set BROWSER_VNC_URL on the server to embed it
      here.
    </Message>
    <template v-else>
      <div class="toolbar">
        <Tag
          :value="status.web.healthy ? 'login healthy' : 'login unhealthy'"
          :severity="status.web.healthy ? 'success' : 'danger'"
          data-testid="browser-health"
        />
        <span class="muted">{{ status.web.reason }}</span>
        <span class="hint">Log in to strava.com below, then press Check login.</span>
        <Button
          label="Check login"
          size="small"
          :disabled="checking"
          data-testid="browser-check"
          @click="check"
        />
        <Button
          label="Reload view"
          size="small"
          text
          data-testid="browser-reload"
          @click="reload"
        />
        <a :href="BROWSER_SRC" target="_blank" rel="noopener" data-testid="browser-fullscreen">
          Open full screen
        </a>
      </div>
      <Message v-if="error" severity="error" data-testid="browser-error">{{ error }}</Message>
      <iframe
        :src="src"
        class="frame"
        title="Strava login browser"
        allow="clipboard-read; clipboard-write"
        data-testid="browser-frame"
      ></iframe>
    </template>
  </section>
</template>

<style scoped>
/* Fills the rest of the viewport under the header: calc(100vh - header). */
.browser {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  padding: 0.4rem 0.75rem;
}
.frame {
  flex: 1;
  width: 100%;
  border: 0;
  padding: 0;
  display: block;
}
.muted,
.hint {
  font-size: 0.85rem;
  opacity: 0.8;
}
</style>
