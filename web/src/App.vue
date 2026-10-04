<script setup lang="ts">
import Button from "primevue/button";
import Message from "primevue/message";
import { onBeforeUnmount, onMounted } from "vue";
import { apiPost, onWrite, toLogin } from "./api.ts";
import FrozenBanner from "./components/FrozenBanner.vue";
import PushControls from "./components/PushControls.vue";
import { shortVersion } from "./labels.ts";
import { route, startRouter } from "./router.ts";
import { STATUS_POLL_MS, refreshStatus, status, statusError } from "./status.ts";
import BackfillView from "./views/BackfillView.vue";
import BrowserView from "./views/BrowserView.vue";
import HistoryView from "./views/HistoryView.vue";
import NotFoundView from "./views/NotFoundView.vue";
import ReviewView from "./views/ReviewView.vue";
import SettingsView from "./views/SettingsView.vue";

const NAV = [
  { name: "review", label: "Review", href: "#/review" },
  { name: "history", label: "History", href: "#/history" },
  { name: "backfill", label: "Backfill", href: "#/backfill" },
  { name: "settings", label: "Settings", href: "#/settings" },
  { name: "browser", label: "Strava login", href: "#/browser" },
] as const;

const cleanups: (() => void)[] = [];

onMounted(() => {
  cleanups.push(startRouter());
  cleanups.push(onWrite(() => void refreshStatus()));
  const timer = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
  cleanups.push(() => clearInterval(timer));
  void refreshStatus();
});

onBeforeUnmount(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function logout(): Promise<void> {
  try {
    await apiPost("/api/auth/logout");
  } catch {
    // The session may already be gone; the login page is the destination either way.
  }
  toLogin();
}
</script>

<template>
  <div class="app">
    <header class="header">
      <strong class="brand">cameld</strong>
      <span v-if="status" class="muted identity" data-testid="identity">{{ status.identity }}</span>
      <span class="spacer"></span>
      <PushControls v-if="status?.push.configured" :public-key="status.push.publicKey ?? ''" />
      <Button label="Log out" size="small" text data-testid="logout" @click="logout" />
    </header>
    <nav class="nav">
      <a
        v-for="item in NAV"
        :key="item.name"
        :href="item.href"
        :class="{ active: route.name === item.name }"
        :data-testid="`nav-${item.name}`"
      >
        {{ item.label }}
      </a>
    </nav>
    <FrozenBanner v-if="status?.frozen.frozen" :freeze="status.frozen" />
    <Message v-if="statusError" severity="error" data-testid="status-error">
      Status unavailable: {{ statusError }}
    </Message>
    <main class="main" :class="{ flush: route.name === 'browser' }">
      <p v-if="status === null" data-testid="app-loading">Loading...</p>
      <ReviewView v-else-if="route.name === 'review'" :style-url="status.map.styleUrl" />
      <HistoryView
        v-else-if="route.name === 'history'"
        :counts="status.counts"
        :group-id="route.groupId"
        :style-url="status.map.styleUrl"
      />
      <BackfillView v-else-if="route.name === 'backfill'" :status="status" />
      <SettingsView v-else-if="route.name === 'settings'" />
      <BrowserView v-else-if="route.name === 'browser'" :status="status" />
      <NotFoundView v-else :path="route.path" />
    </main>
    <footer v-if="status" class="footer">
      <span data-testid="version" :title="`cameld build ${status.version}`">{{
        shortVersion(status.version)
      }}</span>
    </footer>
  </div>
</template>

<style>
body {
  margin: 0;
  font-family: system-ui, sans-serif;
}
</style>

<style scoped>
.header {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  align-items: center;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #d1d5db;
}
.brand {
  font-size: 1.2rem;
}
.spacer {
  flex: 1;
}
.muted {
  opacity: 0.75;
  font-size: 0.85rem;
}
.identity {
  min-width: 0;
  overflow-wrap: anywhere;
}
.nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1.25rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #d1d5db;
}
.nav a {
  color: inherit;
  text-decoration: none;
  padding-bottom: 0.2rem;
}
.nav a.active {
  border-bottom: 2px solid #2563eb;
  font-weight: 600;
}
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.main {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 1rem;
}
.footer {
  padding: 0.25rem 1rem;
  font-size: 0.7rem;
  opacity: 0.6;
  text-align: right;
  border-top: 1px solid #d1d5db;
}
.main.flush {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
