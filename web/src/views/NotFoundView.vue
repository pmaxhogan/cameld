<script setup lang="ts">
defineProps<{ path: string }>();

const LINKS = [
  { href: "#/review", label: "Review queue" },
  { href: "#/history", label: "History" },
  { href: "#/backfill", label: "Backfill" },
  { href: "#/settings", label: "Settings" },
  { href: "#/browser", label: "Strava login" },
] as const;
</script>

<template>
  <section data-testid="not-found">
    <h2>Page not found</h2>
    <p>
      There is no page at <code data-testid="not-found-path">#/{{ path }}</code
      >. It may be a mistyped or outdated link.
    </p>
    <ul>
      <li v-for="link in LINKS" :key="link.href">
        <a :href="link.href">{{ link.label }}</a>
      </li>
    </ul>
  </section>
</template>

<style scoped>
code {
  overflow-wrap: anywhere;
}
</style>
